import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import type { Client as LexofficeClient } from "@miragon/client-lexoffice"
import { withRetry } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { customerSourceValues, FIELD_CATALOG } from "../shared/field-catalog.js"
import { applyMapping, EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { normalizeName } from "../shared/matching.js"
import { buildLexofficeContactBody } from "./contact-body.js"
import {
  contactName,
  contactNumber,
  LexofficeContactLookup,
  numericLexwareNumber,
} from "./contact-lookup.js"
import type { LexContact } from "./contact-lookup.js"
import type { CustomerAlignRow, LexofficeSyncSteps } from "./types.js"

/** Ergebnis der mehrstufigen Kunden-Auflösung. Nur `match`/`none` schreiben. */
export type ContactResolution =
  | { kind: "match"; contact: LexContact; matchedBy: "number" | "name"; note?: string }
  | { kind: "none" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "conflict"; reason: string }

/** Kandidaten-IDs für die Ergebniszeile — gekappt, damit die Zeile lesbar bleibt. */
const MAX_LISTED_IDS = 5

/**
 * Im Lauf mehrfach vergebene Dimacon-Schlüssel. Bewusst ein benanntes Objekt
 * statt zweier gleichtypiger Positionsargumente: vertauscht wären beide Sets
 * für den Compiler identisch und der Schutz still wirkungslos.
 */
export interface DimaconDuplicateKeys {
  /** Normalisierte Kundennamen, die mehrfach vorkommen — Namensstufe gesperrt */
  readonly names: ReadonlySet<string>
  /** Normalisierte Kundennummern, die mehrfach vorkommen — kein gültiger Schlüssel */
  readonly numbers: ReadonlySet<string>
}

export const NO_DUPLICATE_KEYS: DimaconDuplicateKeys = { names: new Set(), numbers: new Set() }

/**
 * Lexware-Kontakt find-or-create + Kundennummern-Alignment.
 *
 * Auflösung mehrstufig (Nummer vor Name):
 *
 * 1. Rein numerische Dimacon-Kundennummer → `GET /v1/contacts?number=…`.
 *    Ein Treffer wird nur akzeptiert, wenn der Name plausibel passt — eine
 *    noch nie angeglichene Nummer ist eine hausinterne Nummer und kann
 *    zufällig einen fremden Lexware-Kontakt treffen.
 * 2. Sonst exakter Firmenname → `GET /v1/contacts?name=…`.
 * 3. Mehrere Treffer (oder ein gleichnamiger Dimacon-Kunde im selben Lauf)
 *    ⇒ KEIN Schreibvorgang, sondern eine Zeile `ambiguous`/`conflict` mit
 *    Begründung — analog zum Mitarbeiter-Abgleich.
 * 4. Fällt Stufe 1 mit einem Fehler aus, darf Stufe 2 noch verknüpfen, aber
 *    nicht mehr ANLEGEN (`conflict`) — sonst wäre der Schutz genau dann aus,
 *    wenn er gebraucht wird.
 *
 * Die Lexware-Create-Response enthält i. d. R. keine `roles` (und damit
 * keine Nummer) — frisch angelegte Kontakte werden deshalb erst beim
 * nächsten Lauf aligned, wenn der Kontakt wiedergefunden wird.
 */
export class CustomerAligner {
  private readonly lookup: LexofficeContactLookup

  constructor(
    private readonly dimaconClient: DimaconClient,
    private readonly lexofficeClient: LexofficeClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
    private readonly steps: LexofficeSyncSteps = { createContacts: true, alignNumbers: true },
    /** Feld-Zuordnung für den Create-Body (Kontakte werden nie aktualisiert) */
    private readonly mapping?: EntityMappingContext,
    private readonly onMappingWarning: (message: string) => void = () => undefined,
    /** Mehrfach vergebene Dimacon-Schlüssel des Laufs — sperren die jeweilige Stufe */
    private readonly duplicates: DimaconDuplicateKeys = NO_DUPLICATE_KEYS,
  ) {
    this.lookup = new LexofficeContactLookup(lexofficeClient)
  }

  async align(customer: DimaconCustomerInfo): Promise<CustomerAlignRow> {
    const resolution = await this.resolve(customer)

    if (resolution.kind === "ambiguous" || resolution.kind === "conflict") {
      this.log.warn("lexware contact not resolved unambiguously — no write", {
        dimaconCustomerId: customer.id,
        name: customer.name,
        kind: resolution.kind,
        reason: resolution.reason,
      })
      return {
        dimaconCustomerId: customer.id,
        name: customer.name,
        status: resolution.kind,
        reason: resolution.reason,
      }
    }

    if (resolution.kind === "none") {
      if (!this.steps.createContacts) {
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          status: "skipped",
          reason: "Kontakt-Schritt deaktiviert — Kontakt existiert nicht in Lexware",
        }
      }
      if (this.dryRun) {
        this.log.info("[dryRun] would create lexware contact", { name: customer.name })
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          status: "created",
          reason: "[dryRun] Lexware-Kontakt würde angelegt",
        }
      }

      const created = await this.createInLexware(customer)
      const createdNumber = contactNumber(created)
      if (
        this.steps.alignNumbers &&
        createdNumber &&
        customer.customerNumber &&
        createdNumber !== customer.customerNumber
      ) {
        await this.alignDimaconNumber(customer, createdNumber)
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          lexwareContactId: created.id,
          lexwareNumber: createdNumber,
          status: "created",
          reason: `Dimacon-Kundennummer ${customer.customerNumber} → ${createdNumber}`,
        }
      }
      return {
        dimaconCustomerId: customer.id,
        name: customer.name,
        lexwareContactId: created.id,
        lexwareNumber: createdNumber,
        status: "created",
      }
    }

    const existing = resolution.contact
    const note = resolution.note
    const lexNumber = contactNumber(existing)
    if (
      this.steps.alignNumbers &&
      lexNumber &&
      customer.customerNumber &&
      lexNumber !== customer.customerNumber
    ) {
      if (this.dryRun) {
        this.log.info("[dryRun] would align dimacon customer number to lexware", {
          dimaconCustomerId: customer.id,
          from: customer.customerNumber,
          to: lexNumber,
        })
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          lexwareContactId: existing.id,
          lexwareNumber: lexNumber,
          status: "aligned",
          reason: withNote(note, `[dryRun] ${customer.customerNumber} → ${lexNumber}`),
        }
      }

      this.log.info("aligning dimacon customer number to lexware", {
        dimaconCustomerId: customer.id,
        from: customer.customerNumber,
        to: lexNumber,
      })
      await this.alignDimaconNumber(customer, lexNumber)
      return {
        dimaconCustomerId: customer.id,
        name: customer.name,
        lexwareContactId: existing.id,
        lexwareNumber: lexNumber,
        status: "aligned",
        reason: withNote(note, `${customer.customerNumber} → ${lexNumber}`),
      }
    }

    return {
      dimaconCustomerId: customer.id,
      name: customer.name,
      lexwareContactId: existing.id,
      lexwareNumber: lexNumber,
      status: "unchanged",
      reason: note,
    }
  }

  /** Mehrstufige Auflösung: Nummer (plausibilisiert) vor Name, Mehrdeutigkeit meldet statt zu schreiben. */
  private async resolve(customer: DimaconCustomerInfo): Promise<ContactResolution> {
    let numberConflictNote: string | undefined
    let numberLookupFailed = false

    // Stufe 1 — Kundennummer. Eine im Lauf mehrfach vergebene Dimacon-Nummer
    // ist kein gültiger Schlüssel und wird gar nicht erst angefragt.
    const numberKey = numericLexwareNumber(customer.customerNumber)
    const numberIsDuplicate = this.duplicates.numbers.has(normalizeName(customer.customerNumber))
    if (numberKey && !numberIsDuplicate) {
      try {
        const hits = await this.lookup.byNumber(numberKey)
        if (hits.length === 1) {
          const hit = hits[0]
          if (normalizeName(contactName(hit)) === normalizeName(customer.name)) {
            return { kind: "match", contact: hit, matchedBy: "number" }
          }
          // Nummer trifft einen fremden Kontakt — NICHT verknüpfen, aber die
          // Namenssuche darf es noch versuchen.
          numberConflictNote = `Kundennummer ${numberKey} gehört in Lexware zu „${contactName(hit) || "(ohne Namen)"}" (${hit.id})`
        } else if (hits.length > 1) {
          return {
            kind: "ambiguous",
            reason: `Kundennummer ${numberKey}: ${hits.length} Lexware-Kontakte (${listIds(hits)}) — nicht eindeutig, kein Schreibvorgang`,
          }
        }
      } catch (err) {
        // Ein Fehler der Nummernsuche darf den Kunden nicht auf `failed`
        // setzen — die Namenssuche bleibt der bisherige Weg. Fail-closed ist
        // aber die ANLAGE: ohne die Nummernstufe fehlt der stärkste Schlüssel,
        // und ein zwischenzeitlich umbenannter Kontakt fände weder über die
        // Nummer noch über den Namen zurück — es entstünde ein Duplikat genau
        // dann, wenn der Schutz gebraucht wird.
        numberLookupFailed = true
        this.log.warn("lexware number lookup failed — name lookup only, no contact creation", {
          dimaconCustomerId: customer.id,
          number: numberKey,
          error: formatError(err),
        })
      }
    }

    // Stufe 2 — Firmenname. Gibt es im selben Lauf einen zweiten Dimacon-Kunden
    // gleichen Namens, ist der Name kein Schlüssel: sonst bekämen beide
    // denselben Kontakt (bzw. legten parallel zwei Kontakte an).
    if (this.duplicates.names.has(normalizeName(customer.name))) {
      return {
        kind: "ambiguous",
        reason: withNote(
          numberConflictNote,
          "weiterer Dimacon-Kunde gleichen Namens im selben Lauf — Auflösung nur über die Kundennummer möglich",
        ),
      }
    }

    const byName = await this.lookup.byName(customer.name)
    if (byName.length === 1) {
      return { kind: "match", contact: byName[0], matchedBy: "name", note: numberConflictNote }
    }
    if (byName.length > 1) {
      return {
        kind: "ambiguous",
        reason: withNote(
          numberConflictNote,
          `${byName.length} Lexware-Kontakte mit gleichem Firmennamen (${listIds(byName)}) — nicht eindeutig, kein Schreibvorgang`,
        ),
      }
    }
    if (numberConflictNote) {
      return {
        kind: "conflict",
        reason: `${numberConflictNote} — kein Namenstreffer, Kontakt wird nicht angelegt`,
      }
    }
    if (numberLookupFailed) {
      return {
        kind: "conflict",
        reason: `Nummernsuche für Kundennummer ${numberKey} fehlgeschlagen — kein Namenstreffer, Kontakt wird in diesem Lauf nicht angelegt`,
      }
    }
    return { kind: "none" }
  }

  private async createInLexware(customer: DimaconCustomerInfo): Promise<LexContact> {
    // Feld-Zuordnung anwenden — ohne Kontext gelten die Default-Regeln,
    // die exakt den bisherigen hartkodierten Body reproduzieren.
    const ctx = this.mapping
    const applied = applyMapping(
      ctx?.rules ?? FIELD_CATALOG.lexofficeContact.defaultRules,
      ctx?.catalog ?? FIELD_CATALOG.lexofficeContact,
      ctx?.discovery ?? EMPTY_DISCOVERY,
      customerSourceValues(customer),
    )
    for (const warning of applied.warnings) {
      this.onMappingWarning(`Kunde ${customer.name}: ${warning.message}`)
    }

    // Bewusst OHNE Retry: der POST ist nicht idempotent — ein serverseitig
    // erfolgreicher, aber verloren gegangener Response würde beim Retry ein
    // Duplikat anlegen. Ein Fehlschlag heilt sich im nächsten Lauf über das
    // Find-or-Create selbst. (429 retryt der Lexoffice-Client intern.)
    return (await this.lexofficeClient.post<LexContact>(
      "/v1/contacts",
      buildLexofficeContactBody(applied, customer.name),
    )) as LexContact
  }

  private async alignDimaconNumber(
    customer: DimaconCustomerInfo,
    customerNumber: string,
  ): Promise<void> {
    await withRetry(() =>
      dimacon.updateCustomer({
        client: this.dimaconClient,
        path: { customerId: customer.id },
        body: {
          name: customer.name,
          customerNumber,
          street: customer.street,
          zipCity: customer.zipCity,
          phoneNumber: customer.phoneNumber,
          email: customer.email,
          description: customer.description,
          // Dimacon-PUT ist ein Voll-Replace: bestehende Attributwerte
          // MÜSSEN zurückgespiegelt werden, sonst werden sie gelöscht.
          customAttributeValues: customer.customAttributeValues ?? [],
        },
      }),
    )
  }
}

/** Stellt einem Grund einen Hinweis voran, falls vorhanden. */
function withNote(note: string | undefined, reason: string): string {
  return note ? `${note} — ${reason}` : reason
}

/** Kandidaten-IDs, gekappt: die Run-Historie kappt Ergebnisse über 512 KB komplett. */
function listIds(contacts: readonly LexContact[]): string {
  const ids = contacts.slice(0, MAX_LISTED_IDS).map((c) => c.id)
  return contacts.length > MAX_LISTED_IDS ? `${ids.join(", ")}, …` : ids.join(", ")
}
