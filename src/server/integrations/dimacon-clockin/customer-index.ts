import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import {
  MAX_CLOCKIN_PAGES,
  clockinPageQuery,
  loadAllClockinPages,
} from "../shared/clockin-pages.js"
import type { ClockinPage } from "../shared/clockin-pages.js"
import { BULK_FETCH_THRESHOLD } from "../shared/dimacon.js"
import { normalizeName } from "../shared/matching.js"

export interface ClockinCustomerRow {
  id?: number
  company?: string
  identifier?: string | null
}

/**
 * Lokaler Index des Clockin-Kundenbestands — ersetzt 1–2 `searchForCustomers`
 * je Dimacon-Kunde durch wenige Seitenabrufe.
 *
 * MEHRWERTIG (Map<Schlüssel, Zeile[]>): die Mehrdeutigkeitserkennung aus #16
 * (mehrere exakte Treffer ⇒ melden statt schreiben) lebt davon, ALLE
 * Kandidaten zu sehen. Ein einwertiger Index würde sie still aushebeln —
 * und die Tests aus #16 blieben trotzdem grün.
 */
export interface ClockinCustomerIndex {
  /** ALLE Zeilen mit exakt diesem Identifier (normalisiert). */
  byIdentifier(needle: string): ClockinCustomerRow[]
  /** ALLE Zeilen mit exakt diesem Firmennamen (normalisiert). */
  byCompany(needle: string): ClockinCustomerRow[]
  /** Im Lauf angelegten Kunden nachtragen — verhindert Doppelanlagen. */
  add(row: ClockinCustomerRow): void
  readonly size: number
}

/** Query-Typ der Kundenliste — trägt den `page`-Parameter nicht (s. clockinPageQuery). */
type CustomerListQuery = NonNullable<Parameters<typeof clockin.getAListOfCustomers>[0]>["query"]

export interface CustomerIndexOptions {
  /**
   * Zahl der im Lauf benötigten Kunden. Unter `BULK_FETCH_THRESHOLD` lohnt
   * sich der Vollabruf nicht: dann bleibt es bei der Einzelsuche.
   */
  neededCustomers: number
  log?: Logger
}

/**
 * Lädt den Clockin-Kundenbestand und indiziert ihn nach Kundennummer und
 * Firmenname. Liefert `undefined`, wenn der Index nicht benutzt werden darf:
 *
 * - mehrseitiger Bestand, aber nur wenige Kunden im Lauf ⇒ Einzelsuchen sind
 *   billiger (genau ein Request wurde dann verbraucht),
 * - unvollständige Paginierung ⇒ ein fehlender Zwilling auf einer nicht
 *   geladenen Seite ließe eine Mehrdeutigkeit als „eindeutig" durchgehen,
 * - Bestand über dem Seiten-Deckel (`MAX_CLOCKIN_PAGES`) ⇒ der Vollabruf
 *   könnte nie vollständig werden, also gar nicht erst anfangen.
 */
export async function loadClockinCustomerIndex(
  client: ClockInClient,
  options: CustomerIndexOptions,
): Promise<ClockinCustomerIndex | undefined> {
  const { neededCustomers, log } = options

  const fetchPage = (page: number | undefined) =>
    withRetry(() =>
      clockin.getAListOfCustomers({
        client,
        query: clockinPageQuery<NonNullable<CustomerListQuery>>(page),
      }),
    ) as unknown as Promise<ClockinPage<ClockinCustomerRow>>

  const first = await fetchPage(undefined)
  // Fail-closed: ohne `meta.last_page` ist unbekannt, ob es weitere Seiten
  // gibt. Ein halber Index sähe einen Zwilling auf der nicht geladenen Seite
  // nicht und machte aus einer Mehrdeutigkeit (#16) still einen eindeutigen
  // Treffer. Dann lieber die Serversuche wie bisher.
  if (typeof first.meta?.last_page !== "number") {
    log?.warn("skipping clockin customer index — Antwort ohne meta.last_page")
    return undefined
  }
  const lastPage = first.meta.last_page

  // Der Deckel steht schon nach Seite 1 fest: `loadAllClockinPages` bricht bei
  // mehr als MAX_CLOCKIN_PAGES Seiten ab — holt vorher aber die Seiten 2 bis
  // 50, und der Index wird danach doch verworfen. Pendant zum Vorab-Check in
  // dimacon-lexoffice/contact-index.ts.
  if (lastPage > MAX_CLOCKIN_PAGES) {
    log?.warn("clockin customer index discarded — page cap reached", {
      maxPages: MAX_CLOCKIN_PAGES,
      lastPage,
    })
    return undefined
  }

  // Der Vollabruf kostet `lastPage` Requests, der Einzelweg höchstens zwei je
  // nachgeschlagenem Kunden. Gegen die Konstante allein zu prüfen kippt die
  // Heuristik, sobald der Bestand viel mehr Seiten hat als der Lauf Kunden.
  if (lastPage > 1 && neededCustomers <= Math.max(BULK_FETCH_THRESHOLD, lastPage)) {
    log?.info("skipping clockin customer index — few customers, paginated inventory", {
      neededCustomers,
      lastPage,
    })
    return undefined
  }

  const loaded = await loadAllClockinPages<ClockinCustomerRow>({
    fetchPage,
    idOf: (r) => r.id,
    log,
    label: "clockin customers",
    // Seite 1 liegt schon vor — sonst würde sie ein zweites Mal geholt.
    first,
  })

  if (!loaded.complete) {
    log?.warn("clockin customer index discarded — inventory incomplete", {
      reason: loaded.reason,
      rows: loaded.rows.length,
    })
    return undefined
  }

  const index = buildIndex(loaded.rows)
  log?.info("clockin customer index built", { rows: index.size, pages: loaded.pages })
  return index
}

/** Reiner Index-Aufbau — ohne API, damit Tests ihn direkt füttern können. */
export function buildIndex(rows: readonly ClockinCustomerRow[]): ClockinCustomerIndex {
  const byIdentifier = new Map<string, ClockinCustomerRow[]>()
  const byCompany = new Map<string, ClockinCustomerRow[]>()
  let size = 0

  const push = (map: Map<string, ClockinCustomerRow[]>, key: string, row: ClockinCustomerRow) => {
    if (!key) return
    const list = map.get(key) ?? []
    list.push(row)
    map.set(key, list)
  }

  const add = (row: ClockinCustomerRow) => {
    if (row.id === undefined) return
    size++
    push(byIdentifier, normalizeName(row.identifier), row)
    push(byCompany, normalizeName(row.company), row)
  }

  for (const row of rows) add(row)

  return {
    byIdentifier: (needle) => byIdentifier.get(normalizeName(needle)) ?? [],
    byCompany: (needle) => byCompany.get(normalizeName(needle)) ?? [],
    add,
    get size() {
      return size
    },
  }
}
