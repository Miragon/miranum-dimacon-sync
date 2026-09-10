import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { customerSourceValues } from "../shared/field-catalog.js"
import { applyMapping } from "../shared/field-mapping.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { normalizeName } from "../shared/matching.js"
import type { CustomerMapping } from "./types.js"

interface ClockinCustomerRow {
  id?: number
  company?: string
  identifier?: string | null
}

type ClockinLookupResult = { row: ClockinCustomerRow | null } | { ambiguous: ClockinCustomerRow[] }

/** Kandidaten-IDs in der Meldung — gekappt, damit die Fehlerliste lesbar bleibt. */
const MAX_LISTED_IDS = 5

/**
 * Wissen über den Dimacon-GESAMTBESTAND, das der Namens-Fallback braucht.
 *
 * Der Tagesausschnitt reicht dafür nicht: der gleichnamige Zwilling eines
 * Kunden hat meistens gerade KEINEN Termin — genau dann griffe ein nur aus
 * dem Tagesausschnitt gebildeter Duplikat-Schutz nicht und der Fallback
 * verknüpfte den Kunden dauerhaft mit dem Clockin-Kunden seines Zwillings.
 */
export interface CustomerMatchingContext {
  /** Normalisierte Kundennamen, die im Gesamtbestand mehrfach vorkommen */
  readonly duplicateNames: ReadonlySet<string>
  /** Alle normalisierten Kundennummern des Gesamtbestands */
  readonly knownCustomerNumbers: ReadonlySet<string>
  /**
   * false = der Gesamtbestand konnte nicht geladen werden. Dann ist der
   * Namens-Fallback nicht absicherbar und entfällt komplett (fail-closed):
   * ein zusätzlicher Clockin-Kunde ist sichtbar und reparierbar, eine falsche
   * Verknüpfung bucht dagegen still und dauerhaft auf den falschen Kunden.
   */
  readonly inventoryLoaded: boolean
}

/** Default für direkte Nutzung/Tests: Fallback erlaubt, nichts Auffälliges bekannt. */
export const OPEN_CUSTOMER_MATCHING: CustomerMatchingContext = {
  duplicateNames: new Set(),
  knownCustomerNumbers: new Set(),
  inventoryLoaded: true,
}

// Body kommt aus der Feld-Zuordnung; Feldnamen sichert validateRules + Katalog.
type CustomerWriteBody = NonNullable<Parameters<typeof clockin.createCustomer>[0]>["body"]

/**
 * Kunden-Sync Dimacon → Clockin. Bewusst ohne Lexware: als Identifier dient
 * die Dimacon-Kundennummer (Fallback: Dimacon-ID). Das Alignment der
 * Kundennummern mit Lexware ist eine eigene Integration
 * (`dimacon-lexoffice`) — läuft sie vorher, sind die Nummern hier bereits
 * konsistent.
 */
export class CustomerSyncer {
  private inflight = new Map<string, Promise<CustomerMapping | null>>()

  constructor(
    private readonly clockinClient: ClockInClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
    /** false = Kunden-Schritt deaktiviert: nur nachschlagen, nie anlegen */
    private readonly createMissing = true,
    /** Feld-Zuordnung für den Create-Body (Kunden werden nie aktualisiert) */
    private readonly mapping?: EntityMappingContext,
    private readonly onMappingWarning: (message: string) => void = () => undefined,
    /** Gesamtbestands-Wissen, das den Namens-Fallback absichert */
    private readonly matching: CustomerMatchingContext = OPEN_CUSTOMER_MATCHING,
    /** Meldung einer nicht auflösbaren Mehrdeutigkeit (landet in `errors`). */
    private readonly onAmbiguous: (message: string) => void = () => undefined,
  ) {}

  async resolve(customer: DimaconCustomerInfo): Promise<CustomerMapping | null> {
    const cached = this.inflight.get(customer.id)
    if (cached) return cached

    const promise = this.doResolve(customer)
    this.inflight.set(customer.id, promise)
    promise.catch(() => this.inflight.delete(customer.id))
    return promise
  }

  private async doResolve(customer: DimaconCustomerInfo): Promise<CustomerMapping | null> {
    const lookupNumber = customer.customerNumber ?? customer.name

    const byNumber = await this.findInClockin(
      lookupNumber,
      customer.customerNumber ? "identifier" : "company",
    )
    if ("ambiguous" in byNumber) {
      return this.reportAmbiguous(customer, lookupNumber, byNumber.ambiguous)
    }

    let found = byNumber.row

    // Fallback per Name: verhindert Duplikat-Kunden, wenn die
    // Dimacon-Kundennummer nachträglich geändert wurde (z. B. durch das
    // Lexware-Alignment der dimacon-lexoffice-Integration), der
    // Clockin-Kunde aber noch unter der alten Nummer angelegt ist.
    // Entfällt bei gleichnamigen Dimacon-Kunden: in Clockin ist der
    // Identifier der Schlüssel, gleichnamige Kunden dürfen dort legitim
    // nebeneinander existieren.
    if (!found && customer.customerNumber) {
      const blocked = this.nameFallbackBlockedBy(customer)
      if (blocked) {
        this.log.info("skipping clockin name fallback", {
          dimaconCustomerId: customer.id,
          name: customer.name,
          reason: blocked,
        })
      } else {
        const byName = await this.findInClockin(customer.name, "company")
        if ("ambiguous" in byName) {
          return this.reportAmbiguous(customer, customer.name, byName.ambiguous)
        }
        const candidate = byName.row
        if (candidate && this.belongsToAnotherDimaconCustomer(candidate, customer)) {
          // Der Namenstreffer trägt die Kundennummer eines ANDEREN
          // Dimacon-Kunden — typisch bei gleichnamigen Firmen. Verknüpfen
          // würde alle Zeiten dauerhaft auf den falschen Kunden buchen.
          this.log.info(
            "rejecting clockin name fallback — identifier belongs to another customer",
            {
              dimaconCustomerId: customer.id,
              clockinCustomerId: candidate.id,
              clockinIdentifier: candidate.identifier ?? null,
              dimaconNumber: customer.customerNumber,
            },
          )
        } else {
          found = candidate
          if (found) {
            this.log.info(
              "clockin customer found by name; identifier differs from dimacon number",
              {
                dimaconCustomerId: customer.id,
                clockinCustomerId: found.id,
                clockinIdentifier: found.identifier ?? null,
                dimaconNumber: customer.customerNumber,
              },
            )
          }
        }
      }
    }

    if (found) {
      return {
        dimaconId: customer.id,
        clockinId: found.id!,
        number: found.identifier ?? lookupNumber,
        name: found.company ?? customer.name,
      }
    }

    if (!this.createMissing) {
      this.log.info("customer not found in clockin; create disabled by steps", {
        dimaconCustomerId: customer.id,
        name: customer.name,
      })
      return null
    }

    const number = customer.customerNumber ?? customer.id
    return this.createInClockin(customer, number)
  }

  /** Grund, warum der Namens-Fallback nicht greifen darf — sonst undefined. */
  private nameFallbackBlockedBy(customer: DimaconCustomerInfo): string | undefined {
    if (!this.matching.inventoryLoaded) return "Dimacon-Kundenbestand nicht geladen"
    if (this.matching.duplicateNames.has(normalizeName(customer.name)))
      return "weiterer Dimacon-Kunde gleichen Namens"
    return undefined
  }

  /**
   * Gehört der Clockin-Kunde erkennbar zu einem anderen Dimacon-Kunden? Sein
   * Identifier ist dann die Kundennummer eines anderen Kunden des
   * Gesamtbestands — und nicht bloß eine veraltete Nummer dieses Kunden.
   */
  private belongsToAnotherDimaconCustomer(
    row: ClockinCustomerRow,
    customer: DimaconCustomerInfo,
  ): boolean {
    const identifier = normalizeName(row.identifier)
    if (!identifier || identifier === normalizeName(customer.customerNumber)) return false
    return this.matching.knownCustomerNumbers.has(identifier)
  }

  /**
   * Sucht über den unscharfen `byNameOrNumber`-Scope und entscheidet LOKAL:
   * genau ein exakter Treffer im gefragten Feld gewinnt; mehrere exakte
   * Treffer sind mehrdeutig. Ohne exakten Treffer bleibt es beim bisherigen
   * Verhalten (genau eine Zeile ⇒ akzeptieren) — sonst würde die Verschärfung
   * bestehende, unscharf gematchte Kunden in Clockin neu anlegen.
   */
  private async findInClockin(
    needle: string,
    field: "identifier" | "company",
  ): Promise<ClockinLookupResult> {
    const result = (await withRetry(() =>
      clockin.searchForCustomers({
        client: this.clockinClient,
        body: { scopes: [{ name: "byNameOrNumber", parameters: [needle] }] },
      }),
    )) as unknown as { data?: ClockinCustomerRow[] }

    const rows = (result.data ?? []).filter((r) => r.id !== undefined)
    if (rows.length === 0) return { row: null }

    const exact = rows.filter((r) => normalizeName(r[field]) === normalizeName(needle))
    if (exact.length === 1) return { row: exact[0] }
    if (exact.length > 1) return { ambiguous: exact }
    if (rows.length === 1) return { row: rows[0] }
    return { ambiguous: rows }
  }

  /** Mehrdeutigkeit: weder verknüpfen noch anlegen — melden und aussteigen. */
  private reportAmbiguous(
    customer: DimaconCustomerInfo,
    needle: string,
    candidates: ClockinCustomerRow[],
  ): null {
    const ids = candidates
      .slice(0, MAX_LISTED_IDS)
      .map((c) => c.id)
      .join(", ")
    const suffix = candidates.length > MAX_LISTED_IDS ? ", …" : ""
    const message = `Kunde ${customer.name}: Suche nach „${needle}" liefert ${candidates.length} Clockin-Kandidaten (IDs ${ids}${suffix}) — nicht eindeutig, weder verknüpft noch angelegt`
    this.log.warn("ambiguous clockin customer match", {
      dimaconCustomerId: customer.id,
      needle,
      candidates: candidates.length,
    })
    this.onAmbiguous(message)
    return null
  }

  private async createInClockin(
    customer: DimaconCustomerInfo,
    number: string,
  ): Promise<CustomerMapping> {
    if (this.dryRun) {
      this.log.info("[dryRun] would create clockin customer", { name: customer.name, number })
      return {
        dimaconId: customer.id,
        clockinId: -1,
        number,
        name: customer.name,
      }
    }

    const body = this.buildCreateBody(customer, number)
    const result = (await withRetry(() =>
      clockin.createCustomer({
        client: this.clockinClient,
        body,
      }),
    )) as unknown as { data?: { id?: number } }

    const id = result.data?.id
    if (id === undefined) {
      throw new Error(`clockin createCustomer returned no id for ${customer.name}`)
    }

    return {
      dimaconId: customer.id,
      clockinId: id,
      number,
      name: customer.name,
    }
  }

  private buildCreateBody(customer: DimaconCustomerInfo, number: string): CustomerWriteBody {
    if (!this.mapping) {
      // Ohne Kontext (Tests, direkte Nutzung): identisch zur Default-Zuordnung
      const values = customerSourceValues(customer)
      return {
        company: customer.name,
        identifier: number,
        street: values.standard.street ?? null,
        zip: values.standard["zipCity.zip"] || null,
        city: values.standard["zipCity.city"] || null,
        country: "DE",
      }
    }

    const applied = applyMapping(
      this.mapping.rules,
      this.mapping.catalog,
      this.mapping.discovery,
      customerSourceValues(customer),
    )
    for (const warning of applied.warnings) {
      this.onMappingWarning(`Kunde ${customer.name}: ${warning.message}`)
    }

    return {
      ...applied.standardFields,
      identifier: number,
      country: "DE",
      ...(applied.customFields.length > 0 ? { custom_fields: applied.customFields } : {}),
    } as CustomerWriteBody
  }
}
