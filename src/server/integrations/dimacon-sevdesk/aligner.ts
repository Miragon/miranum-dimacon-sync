import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import type { Client as SevdeskClient } from "@miragon/client-sevdesk"
import { withRetry } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { customerSourceValues, FIELD_CATALOG } from "../shared/field-catalog.js"
import { applyMapping, EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { normalizeName } from "../shared/matching.js"
import { buildSevdeskContactBodies, CUSTOMER_CATEGORY } from "./contact-body.js"
import {
  contactName,
  contactNumber,
  SevdeskContactLookup,
  sevdeskNumberKey,
} from "./contact-lookup.js"
import type { ContactSource, SevdeskContact } from "./contact-lookup.js"
import type { CustomerAlignRow, SevdeskSyncSteps } from "./types.js"

/** Ergebnis der mehrstufigen Kunden-Auflösung. Nur `match`/`none` schreiben. */
export type ContactResolution =
  | { kind: "match"; contact: SevdeskContact; matchedBy: "number" | "name"; note?: string }
  | { kind: "none" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "conflict"; reason: string }

/** Kandidaten-IDs für die Ergebniszeile — gekappt, damit die Zeile lesbar bleibt. */
const MAX_LISTED_IDS = 5

/**
 * Im Lauf mehrfach vergebene Dimacon-Schlüssel (gleiches benanntes Objekt
 * wie im Lexoffice-Aligner — zwei gleichtypige Positionsargumente wären für
 * den Compiler identisch und der Schutz still wirkungslos).
 */
export interface DimaconDuplicateKeys {
  /** Normalisierte Kundennamen, die mehrfach vorkommen — Namensstufe gesperrt */
  readonly names: ReadonlySet<string>
  /** Normalisierte Kundennummern, die mehrfach vorkommen — kein gültiger Schlüssel */
  readonly numbers: ReadonlySet<string>
}

export const NO_DUPLICATE_KEYS: DimaconDuplicateKeys = { names: new Set(), numbers: new Set() }

/**
 * sevDesk-Kontakt find-or-create + Kundennummern-Alignment — Spiegel des
 * Lexoffice-Aligners (dimacon-lexoffice/aligner.ts), gleiche Auflösung:
 *
 * 1. Dimacon-Kundennummer → `GET /Contact?customerNumber=…`. Ein Treffer
 *    wird nur akzeptiert, wenn der Name plausibel passt — eine noch nie
 *    angeglichene Nummer ist eine hausinterne Nummer und kann zufällig
 *    einen fremden sevDesk-Kontakt treffen.
 * 2. Sonst exakter Name → `GET /Contact?name=…`.
 * 3. Mehrere Treffer (oder ein gleichnamiger Dimacon-Kunde im selben Lauf)
 *    ⇒ KEIN Schreibvorgang, sondern eine Zeile `ambiguous`/`conflict`.
 * 4. Fällt Stufe 1 mit einem Fehler aus, darf Stufe 2 noch verknüpfen, aber
 *    nicht mehr ANLEGEN (`conflict`).
 *
 * Unterschied zu Lexware: sevDesk vergibt beim Create NICHT automatisch
 * eine Kundennummer. Ist die Dimacon-Nummer nachweislich frei (Stufe 1 lief
 * mit 0 Treffern), wird sie beim Anlegen mitgegeben — Nummern sind dann ab
 * dem ersten Lauf konsistent. Sonst entsteht der Kontakt ohne Nummer und
 * das Alignment greift, sobald sevDesk-seitig eine vergeben wurde
 * (beide Nummern vorhanden und verschieden ⇒ sevDesk gewinnt).
 */
export class SevdeskAligner {
  private readonly lookup: ContactSource

  constructor(
    private readonly dimaconClient: DimaconClient,
    private readonly sevdeskClient: SevdeskClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
    private readonly steps: SevdeskSyncSteps = { createContacts: true, alignNumbers: true },
    /** Feld-Zuordnung für den Create-Body (Kontakte werden nie aktualisiert) */
    private readonly mapping?: EntityMappingContext,
    private readonly onMappingWarning: (message: string) => void = () => undefined,
    /**
     * Teil-Fehler beim Anlegen (Adresse/Kommunikationswege): der Kontakt
     * existiert, die Zeile bleibt `created` — aber der Lauf soll den Fehler
     * zählen und begründen.
     */
    private readonly onCreateProblem: (customerId: string, message: string) => void = () =>
      undefined,
    /** Mehrfach vergebene Dimacon-Schlüssel des Laufs — sperren die jeweilige Stufe */
    private readonly duplicates: DimaconDuplicateKeys = NO_DUPLICATE_KEYS,
    /**
     * Vorab geladener Voll-Index der sevDesk-Kontakte. Vorhanden = 0 statt
     * ein GET je Kunde; signaturgleich zur Serversuche. Fehlt er, gilt die
     * Serversuche je Kunde.
     */
    index?: ContactSource,
  ) {
    this.lookup = index ?? new SevdeskContactLookup(sevdeskClient)
  }

  async align(customer: DimaconCustomerInfo): Promise<CustomerAlignRow> {
    const resolution = await this.resolve(customer)

    if (resolution.kind === "ambiguous" || resolution.kind === "conflict") {
      this.log.warn("sevdesk contact not resolved unambiguously — no write", {
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
          reason: "Kontakt-Schritt deaktiviert — Kontakt existiert nicht in sevDesk",
        }
      }
      if (this.dryRun) {
        this.log.info("[dryRun] would create sevdesk contact", { name: customer.name })
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          status: "created",
          reason: "[dryRun] sevDesk-Kontakt würde angelegt",
        }
      }

      const { created, problems, seededNumber } = await this.createInSevdesk(customer)
      // Die Create-Response echot eine mitgegebene Nummer nicht zwingend —
      // maßgeblich ist, was jetzt in sevDesk steht: Server-Echo vor Seed.
      const createdNumber = contactNumber(created) ?? seededNumber
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
          sevdeskContactId: created.id,
          sevdeskNumber: createdNumber,
          status: "created",
          reason: joinReasons(problems, [
            `Dimacon-Kundennummer ${customer.customerNumber} → ${createdNumber}`,
          ]),
        }
      }
      return {
        dimaconCustomerId: customer.id,
        name: customer.name,
        sevdeskContactId: created.id,
        sevdeskNumber: createdNumber,
        status: "created",
        reason: joinReasons(problems, []),
      }
    }

    const existing = resolution.contact
    const note = resolution.note
    const sevNumber = contactNumber(existing)
    if (
      this.steps.alignNumbers &&
      sevNumber &&
      customer.customerNumber &&
      sevNumber !== customer.customerNumber
    ) {
      if (this.dryRun) {
        this.log.info("[dryRun] would align dimacon customer number to sevdesk", {
          dimaconCustomerId: customer.id,
          from: customer.customerNumber,
          to: sevNumber,
        })
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          sevdeskContactId: existing.id,
          sevdeskNumber: sevNumber,
          status: "aligned",
          reason: withNote(note, `[dryRun] ${customer.customerNumber} → ${sevNumber}`),
        }
      }

      this.log.info("aligning dimacon customer number to sevdesk", {
        dimaconCustomerId: customer.id,
        from: customer.customerNumber,
        to: sevNumber,
      })
      await this.alignDimaconNumber(customer, sevNumber)
      return {
        dimaconCustomerId: customer.id,
        name: customer.name,
        sevdeskContactId: existing.id,
        sevdeskNumber: sevNumber,
        status: "aligned",
        reason: withNote(note, `${customer.customerNumber} → ${sevNumber}`),
      }
    }

    return {
      dimaconCustomerId: customer.id,
      name: customer.name,
      sevdeskContactId: existing.id,
      sevdeskNumber: sevNumber,
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
    const numberKey = sevdeskNumberKey(customer.customerNumber)
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
          numberConflictNote = `Kundennummer ${numberKey} gehört in sevDesk zu „${contactName(hit) || "(ohne Namen)"}" (${hit.id})`
        } else if (hits.length > 1) {
          return {
            kind: "ambiguous",
            reason: `Kundennummer ${numberKey}: ${hits.length} sevDesk-Kontakte (${listIds(hits)}) — nicht eindeutig, kein Schreibvorgang`,
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
        this.log.warn("sevdesk number lookup failed — name lookup only, no contact creation", {
          dimaconCustomerId: customer.id,
          number: numberKey,
          error: formatError(err),
        })
      }
    }

    // Stufe 2 — Name. Gibt es im selben Lauf einen zweiten Dimacon-Kunden
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
          `${byName.length} sevDesk-Kontakte mit gleichem Namen (${listIds(byName)}) — nicht eindeutig, kein Schreibvorgang`,
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

  private async createInSevdesk(
    customer: DimaconCustomerInfo,
  ): Promise<{ created: SevdeskContact; problems: string[]; seededNumber?: string }> {
    // Feld-Zuordnung anwenden — ohne Kontext gelten die Default-Regeln.
    const ctx = this.mapping
    const applied = applyMapping(
      ctx?.rules ?? FIELD_CATALOG.sevdeskContact.defaultRules,
      ctx?.catalog ?? FIELD_CATALOG.sevdeskContact,
      ctx?.discovery ?? EMPTY_DISCOVERY,
      customerSourceValues(customer),
    )
    for (const warning of applied.warnings) {
      this.onMappingWarning(`Kunde ${customer.name}: ${warning.message}`)
    }

    // Nummer nur seeden, wenn Stufe 1 sie nachweislich frei fand: `none`
    // heißt bei vorhandenem, nicht mehrfach vergebenem Schlüssel, dass die
    // Nummernsuche 0 Treffer hatte (Fehler und Konflikte enden nie hier).
    const numberKey = sevdeskNumberKey(customer.customerNumber)
    const seedNumber =
      numberKey && !this.duplicates.numbers.has(normalizeName(customer.customerNumber))
        ? numberKey
        : undefined

    const payload = buildSevdeskContactBodies(applied, customer.name, seedNumber)

    // Bewusst OHNE Retry: der POST ist nicht idempotent — ein serverseitig
    // erfolgreicher, aber verloren gegangener Response würde beim Retry ein
    // Duplikat anlegen. Ein Fehlschlag heilt sich im nächsten Lauf über das
    // Find-or-Create selbst. (429 retryt der sevDesk-Client intern.)
    const created = unwrapObject(
      await this.sevdeskClient.post<unknown>("/Contact", payload.contact),
    )

    // Adresse + Kommunikationswege sind eigene Ressourcen — best-effort:
    // der Kontakt existiert bereits, ein Teilfehler darf die Zeile nicht auf
    // `failed` setzen (Kontakte werden nie aktualisiert, der nächste Lauf
    // fasst sie nicht mehr an — der Fehler muss also gemeldet werden).
    const problems: string[] = []
    const contactRef = { id: created.id, objectName: "Contact" }
    if (payload.address) {
      try {
        await this.sevdeskClient.post("/ContactAddress", {
          ...payload.address,
          contact: contactRef,
        })
      } catch (err) {
        const message = `Adresse konnte nicht angelegt werden (${formatError(err)})`
        problems.push(message)
        this.onCreateProblem(customer.id, `Kunde ${customer.name}: ${message}`)
      }
    }
    for (const way of payload.communicationWays) {
      try {
        await this.sevdeskClient.post("/CommunicationWay", { ...way, contact: contactRef })
      } catch (err) {
        const label = way.type === "EMAIL" ? "E-Mail" : "Telefon"
        const message = `${label} konnte nicht angelegt werden (${formatError(err)})`
        problems.push(message)
        this.onCreateProblem(customer.id, `Kunde ${customer.name}: ${message}`)
      }
    }

    // Frisch angelegten Kontakt sofort auffindbar machen: zwei gleichnamige
    // Dimacon-Kunden im selben Lauf legten sonst zwei Kontakte an. Der
    // Create-Response wird nicht vertraut — Name/Nummer/Kategorie aus dem
    // Request nachhelfen, falls sie fehlen.
    this.lookup.add?.({
      ...created,
      name: created.name ?? customer.name,
      customerNumber: created.customerNumber ?? seedNumber,
      category: created.category ?? CUSTOMER_CATEGORY,
    })

    return { created, problems, seededNumber: seedNumber }
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

/**
 * sevDesk verpackt Einzel-Antworten als `{ "objects": {…} }` (bei manchen
 * Endpunkten als einelementiges Array) — defensiv beides auspacken.
 */
function unwrapObject(raw: unknown): SevdeskContact {
  if (raw !== null && typeof raw === "object" && "objects" in raw) {
    const objects = (raw as { objects: unknown }).objects
    if (Array.isArray(objects)) return objects[0] as SevdeskContact
    if (objects !== null && typeof objects === "object") return objects as SevdeskContact
  }
  return raw as SevdeskContact
}

/** Stellt einem Grund einen Hinweis voran, falls vorhanden. */
function withNote(note: string | undefined, reason: string): string {
  return note ? `${note} — ${reason}` : reason
}

/** Teilfehler + Zusatzgründe zu einer Hinweis-Zeile verbinden. */
function joinReasons(problems: string[], extra: string[]): string | undefined {
  const parts = [...extra, ...problems]
  return parts.length > 0 ? parts.join("; ") : undefined
}

/** Kandidaten-IDs, gekappt: die Run-Historie kappt Ergebnisse über 512 KB komplett. */
function listIds(contacts: readonly SevdeskContact[]): string {
  const ids = contacts.slice(0, MAX_LISTED_IDS).map((c) => c.id)
  return contacts.length > MAX_LISTED_IDS ? `${ids.join(", ")}, …` : ids.join(", ")
}
