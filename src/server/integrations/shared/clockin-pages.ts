import { formatError } from "../../lib/errors.js"
import type { Logger } from "../../lib/log.js"

/** Laravel-Paginierung: alle Clockin-Listen liefern `meta` mit den Seiteninfos. */
export interface ClockinPageMeta {
  current_page?: number
  last_page?: number
  per_page?: number
  total?: number
}

export interface ClockinPage<T> {
  data?: T[]
  meta?: ClockinPageMeta
}

export interface ClockinPagesResult<T> {
  rows: T[]
  /** false ⇒ die Liste ist nachweislich unvollständig — `reason` nennt den Grund */
  complete: boolean
  reason?: string
  /** tatsächlich gelesene Seiten (inkl. der abgebrochenen) */
  pages: number
}

/** Fail-Safe-Deckel gegen endlose Paginierung (Clockin liefert ~100 Zeilen/Seite). */
export const MAX_CLOCKIN_PAGES = 50

export interface LoadAllClockinPagesOptions<T> {
  /**
   * Lädt eine Seite. Seite 1 kommt als `undefined` — sie wird bewusst OHNE
   * `page`-Query geholt, damit Bestände mit nur einer Seite kein 422-Risiko
   * durch einen unbekannten Query-Parameter tragen.
   */
  fetchPage: (page: number | undefined) => Promise<ClockinPage<T>>
  /** ID der Zeile — dient der Dedupe- und Fortschrittsprüfung */
  idOf: (row: T) => number | undefined
  maxPages?: number
  log?: Logger
  /** Für die Log-Zeile, z. B. "clockin employees" */
  label?: string
}

/**
 * Liest alle Seiten einer Clockin-Liste. Fehler der ERSTEN Seite werfen
 * weiter (harter Ladefehler); ab Seite 2 gilt fail-safe: jeder Zweifel an der
 * Vollständigkeit liefert `complete:false` samt Grund, statt den Lauf zu
 * beenden — der Aufrufer entscheidet, was er mit einer unvollständigen
 * Vergleichsbasis noch tun darf.
 *
 * Drei Abbruchwächter: die API ignoriert `page` (`meta.current_page` passt
 * nicht), eine Folgeseite bringt keine neuen IDs, oder eine Folgeseite
 * schlägt fehl.
 */
export async function loadAllClockinPages<T>(
  options: LoadAllClockinPagesOptions<T>,
): Promise<ClockinPagesResult<T>> {
  const { fetchPage, idOf, log, label = "clockin list" } = options
  const maxPages = options.maxPages ?? MAX_CLOCKIN_PAGES

  const rows: T[] = []
  const seen = new Set<number>()

  const append = (page: ClockinPage<T>): number => {
    let added = 0
    for (const row of page.data ?? []) {
      const id = idOf(row)
      if (id !== undefined) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      rows.push(row)
      added++
    }
    return added
  }

  const first = await fetchPage(undefined)
  append(first)
  let pages = 1

  const lastPage = first.meta?.last_page ?? 1
  if (lastPage <= 1) return { rows, complete: true, pages }

  const incomplete = (reason: string): ClockinPagesResult<T> => {
    log?.warn("clockin pagination incomplete", { label, reason, pages, rows: rows.length })
    return { rows, complete: false, reason, pages }
  }

  const upTo = Math.min(lastPage, maxPages)
  for (let page = 2; page <= upTo; page++) {
    let response: ClockinPage<T>
    try {
      response = await fetchPage(page)
    } catch (err) {
      return incomplete(`Seite ${page} konnte nicht geladen werden: ${formatError(err)}`)
    }
    pages++

    const currentPage = response.meta?.current_page
    if (currentPage !== undefined && currentPage !== page) {
      return incomplete(
        `die Clockin-API hat den Parameter „page“ ignoriert (Seite ${page} kam als Seite ${currentPage} zurück)`,
      )
    }

    if (append(response) === 0) {
      return incomplete(`Seite ${page} enthielt keine neuen Datensätze`)
    }
  }

  if (lastPage > maxPages) {
    return incomplete(`mehr als ${maxPages} Seiten (${lastPage} gemeldet) — Abbruch nach dem Limit`)
  }

  return { rows, complete: true, pages }
}
