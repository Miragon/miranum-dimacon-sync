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
  /**
   * false ⇒ die Liste ist nachweislich unvollständig — `reason` nennt den
   * Grund. true heißt: alle laut `meta.last_page` angekündigten Seiten wurden
   * gelesen. Fehlt `meta.last_page` ganz, gilt die Antwort per Default als
   * EINE vollständige Seite — wer das nicht annehmen darf, setzt `requireMeta`.
   */
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
  /**
   * Bereits geladene erste Seite. Aufrufer, die `meta` vorab brauchen (z. B.
   * um den Vollabruf gar nicht erst zu starten), sparen damit den doppelten
   * Request auf Seite 1.
   */
  first?: ClockinPage<T>
  /**
   * true ⇒ eine Antwort ohne verwertbares `meta.last_page` gilt als
   * unvollständig. Ohne `meta` ist die Seitenzahl UNBEKANNT, nicht „eins".
   * Der Default bleibt bewusst permissiv: Aufrufer, die nur Zeilen
   * verarbeiten (Archiv-Phase), tun auf einer Teilliste höchstens zu WENIG.
   * Aufrufer, deren Korrektheit an der Vollständigkeit hängt — die Anlage von
   * Mitarbeitern —, setzen das Flag und bekommen fail-closed `complete:false`.
   */
  requireMeta?: boolean
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
 * schlägt fehl. Mit `requireMeta` kommt ein vierter dazu: eine erste Seite
 * ohne verwertbares `meta.last_page` beweist keine Vollständigkeit.
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

  const first = options.first ?? (await fetchPage(undefined))
  append(first)
  let pages = 1

  const incomplete = (reason: string): ClockinPagesResult<T> => {
    log?.warn("clockin pagination incomplete", { label, reason, pages, rows: rows.length })
    return { rows, complete: false, reason, pages }
  }

  // Ohne verwertbares `meta.last_page` ist die Seitenzahl unbekannt — das ist
  // KEIN Beweis für eine Einzelseite. Wer darauf Anlagen stützt, bekommt
  // fail-closed. Kriterium identisch zu customer-index.ts, damit die beiden
  // Wächter nicht auseinanderdriften (auch `null` zählt als unbekannt).
  if (options.requireMeta && typeof first.meta?.last_page !== "number") {
    return incomplete("Antwort ohne verwertbares meta.last_page — Seitenzahl unbekannt")
  }

  const lastPage = first.meta?.last_page ?? 1
  if (lastPage <= 1) return { rows, complete: true, pages }

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

/**
 * Der Laravel-Query-Parameter `page` fehlt in den generierten SDK-Typen, die
 * API wertet ihn aber aus (`meta.current_page`/`last_page`). Der Cast ist
 * bewusst an genau dieser Stelle gebündelt — die Abbruchwächter in
 * `loadAllClockinPages` sind der Fail-Safe, falls die API ihn doch ignoriert.
 *
 * Seite 1 geht bewusst OHNE Query raus (`undefined`), damit Bestände mit nur
 * einer Seite kein 422-Risiko durch einen unbekannten Parameter tragen.
 */
export function clockinPageQuery<Q>(page: number | undefined): Q | undefined {
  if (page === undefined) return undefined
  return { page } as unknown as Q
}
