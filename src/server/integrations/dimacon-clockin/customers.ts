import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { NON_IDEMPOTENT_RETRY, withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import type { ClockinPage } from "../shared/clockin-pages.js"
import type { ClockinCustomerIndex } from "./customer-index.js"
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

/**
 * Rohbefund eines Clockin-Lookups. `exact` = das gefragte Feld entspricht
 * exakt dem Suchwert, `similar` = weitere, nur unscharfe Treffer.
 * `exactComplete` = false, wenn ein exakter Treffer auf einer nicht
 * gelesenen Seite der unscharfen Suche liegen könnte.
 */
interface ClockinLookup {
  exact: ClockinCustomerRow[]
  similar: ClockinCustomerRow[]
  exactComplete: boolean
}

/** Entscheidung über einen Lookup: Treffer, Sperre (gemeldet) oder kein Treffer. */
type LookupDecision =
  | { kind: "found"; row: ClockinCustomerRow }
  | { kind: "blocked" }
  | { kind: "none"; similar: ClockinCustomerRow[] }

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
    /**
     * Meldungen für den Betreiber (landen in `errors`): Dubletten in Clockin,
     * nicht exakt prüfbare Suchen und Neuanlagen trotz ähnlicher Kunden.
     */
    private readonly onReport: (message: string) => void = () => undefined,
    /**
     * Vorab geladener Clockin-Kundenbestand. Vorhanden = exakte Treffer
     * kommen ohne einen einzigen `searchForCustomers`-Aufruf zustande.
     */
    private readonly index?: ClockinCustomerIndex,
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

    const byNumber = await this.decide(
      customer,
      lookupNumber,
      customer.customerNumber ? "identifier" : "company",
    )
    if (byNumber.kind === "blocked") return null

    let found = byNumber.kind === "found" ? byNumber.row : null
    const similar = byNumber.kind === "none" ? [...byNumber.similar] : []

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
        const byName = await this.decide(customer, customer.name, "company")
        if (byName.kind === "blocked") return null
        if (byName.kind === "none") similar.push(...byName.similar)
        const candidate = byName.kind === "found" ? byName.row : null
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
    const created = await this.createInClockin(customer, number)
    this.reportSimilar(customer, number, similar)
    return created
  }

  /**
   * Genau ein exakter Treffer gewinnt; mehrere exakte Treffer sind eine
   * echte Dublette in Clockin und werden gemeldet. Ohne exakten Treffer
   * zählt ein EINZELNER unscharfer Treffer weiter als Match (sonst legte die
   * Verschärfung bestehende, unscharf gematchte Kunden neu an) — aber nur,
   * wenn er nicht erkennbar einem anderen Dimacon-Kunden gehört. Mehrere
   * unscharfe Treffer heißen „nicht vorhanden": sie blockieren nichts mehr,
   * sondern erscheinen als Hinweis bei der Anlage.
   */
  private async decide(
    customer: DimaconCustomerInfo,
    needle: string,
    field: "identifier" | "company",
  ): Promise<LookupDecision> {
    const lookup = await this.findInClockin(needle, field)

    if (lookup.exact.length === 1) return { kind: "found", row: lookup.exact[0] }
    if (lookup.exact.length > 1) {
      this.reportDuplicates(customer, needle, field, lookup.exact)
      return { kind: "blocked" }
    }
    if (!lookup.exactComplete) {
      // Ein exakter Treffer könnte auf einer nicht gelesenen Seite liegen —
      // eine Anlage erzeugte dann eine Dublette.
      this.report(
        customer,
        needle,
        `Kunde ${customer.name}: die Clockin-Suche nach „${needle}" ist nicht vollständig prüfbar (mehrseitig oder ohne Seitenangabe) — kein exakter Abgleich möglich, weder verknüpft noch angelegt`,
      )
      return { kind: "blocked" }
    }

    const similar = lookup.similar.filter((r) => !this.belongsToAnotherDimaconCustomer(r, customer))
    if (lookup.similar.length === 1 && similar.length === 1) {
      this.log.info("clockin customer accepted by single fuzzy hit", {
        dimaconCustomerId: customer.id,
        needle,
        clockinCustomerId: similar[0].id,
        clockinIdentifier: similar[0].identifier ?? null,
        clockinCompany: similar[0].company ?? null,
      })
      return { kind: "found", row: similar[0] }
    }
    return { kind: "none", similar }
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
   * Exakte Treffer kommen aus einer VOLLSTÄNDIGEN Quelle — dem Index
   * (kompletter Bestand) bzw. für Nummern dem exakten `byIdentifier`-Scope.
   * Die unscharfe `byNameOrNumber`-Suche liefert danach nur noch Kandidaten
   * für den Einzeltreffer und den Hinweis. Vorher wurde die Nummer allein
   * über die unscharfe Suche gesucht: mehrere Beinahe-Treffer ohne exakten
   * (Alt-Kunden, deren Identifier die Nummer nur ENTHÄLT) blockierten den
   * Kunden dauerhaft, und ein exakter Treffer auf Seite 2 blieb unsichtbar.
   */
  private async findInClockin(
    needle: string,
    field: "identifier" | "company",
  ): Promise<ClockinLookup> {
    let exactSourceComplete = false
    if (this.index) {
      // Der Index ist MEHRWERTIG — die Dubletten-Erkennung sieht hier
      // dieselben Kandidaten wie bei der Serversuche.
      const exact =
        field === "identifier" ? this.index.byIdentifier(needle) : this.index.byCompany(needle)
      if (exact.length > 0) return { exact, similar: [], exactComplete: true }
      exactSourceComplete = true
    } else if (field === "identifier") {
      const exact = await this.searchCustomers("byIdentifier", needle).then((page) =>
        page.rows.filter((r) => normalizeName(r.identifier) === normalizeName(needle)),
      )
      if (exact.length > 0) return { exact, similar: [], exactComplete: true }
      exactSourceComplete = true
    }

    const fuzzy = await this.searchCustomers("byNameOrNumber", needle)
    const exact = fuzzy.rows.filter((r) => normalizeName(r[field]) === normalizeName(needle))
    return {
      exact,
      similar: fuzzy.rows.filter((r) => !exact.includes(r)),
      exactComplete: exactSourceComplete || fuzzy.complete,
    }
  }

  /**
   * Erste Ergebnisseite einer Kundensuche. `complete` nur, wenn belegt ist,
   * dass keine weitere Seite folgt — ohne `meta.last_page` ist die
   * Seitenzahl unbekannt, nicht „eins" (wie `requireMeta` in clockin-pages.ts).
   */
  private async searchCustomers(
    scope: "byIdentifier" | "byNameOrNumber",
    needle: string,
  ): Promise<{ rows: ClockinCustomerRow[]; complete: boolean }> {
    const result = (await withRetry(() =>
      clockin.searchForCustomers({
        client: this.clockinClient,
        body: { scopes: [{ name: scope, parameters: [needle] }] },
      }),
    )) as unknown as ClockinPage<ClockinCustomerRow>

    const rows = (result.data ?? []).filter((r) => r.id !== undefined)
    const lastPage = result.meta?.last_page
    return {
      rows,
      complete: rows.length === 0 || (typeof lastPage === "number" && lastPage <= 1),
    }
  }

  /** Mehrere exakte Treffer: weder verknüpfen noch anlegen — in Clockin bereinigen. */
  private reportDuplicates(
    customer: DimaconCustomerInfo,
    needle: string,
    field: "identifier" | "company",
    candidates: ClockinCustomerRow[],
  ): void {
    const what = field === "identifier" ? "die Nummer" : "den Namen"
    this.report(
      customer,
      needle,
      `Kunde ${customer.name}: ${candidates.length} Clockin-Kunden tragen ${what} „${needle}" (IDs ${listIds(candidates)}) — Dublette in Clockin, bitte dort zusammenführen; weder verknüpft noch angelegt`,
    )
  }

  /** Neuanlage trotz ähnlicher Kunden: nicht blockieren, aber sichtbar machen. */
  private reportSimilar(
    customer: DimaconCustomerInfo,
    number: string,
    similar: ClockinCustomerRow[],
  ): void {
    const unique = [...new Map(similar.map((r) => [r.id, r])).values()]
    if (unique.length === 0) return
    const action = this.dryRun ? "würde neu angelegt" : "neu angelegt"
    this.report(
      customer,
      number,
      `Kunde ${customer.name}: in Clockin ${action} (Nummer ${number}) — ${unique.length} ähnliche Clockin-Kunden (IDs ${listIds(unique)}), bitte prüfen, ob einer davon derselbe Kunde ist`,
    )
  }

  private report(customer: DimaconCustomerInfo, needle: string, message: string): void {
    this.log.warn("clockin customer report", { dimaconCustomerId: customer.id, needle, message })
    this.onReport(message)
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
    const result = (await withRetry(
      () =>
        clockin.createCustomer({
          client: this.clockinClient,
          body,
        }),
      // Anlage ist nicht idempotent: ein 5xx NACH dem Insert würde beim
      // Retry einen zweiten Kunden anlegen.
      NON_IDEMPOTENT_RETRY,
    )) as unknown as { data?: { id?: number } }

    const id = result.data?.id
    if (id === undefined) {
      throw new Error(`clockin createCustomer returned no id for ${customer.name}`)
    }

    // Frisch angelegten Kunden sofort auffindbar machen: zwei gleichnamige
    // Dimacon-Kunden im selben Lauf legten sonst zwei Clockin-Kunden an.
    this.index?.add({ id, company: customer.name, identifier: number })

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

/** „7, 8, 9" bzw. „1, 2, 3, 4, 5, …" — gekappt auf MAX_LISTED_IDS. */
function listIds(rows: ClockinCustomerRow[]): string {
  const ids = rows
    .slice(0, MAX_LISTED_IDS)
    .map((r) => r.id)
    .join(", ")
  return rows.length > MAX_LISTED_IDS ? `${ids}, …` : ids
}
