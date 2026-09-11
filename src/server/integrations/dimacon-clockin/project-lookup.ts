import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { createLimit, withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import { normalizeName } from "../shared/matching.js"

/**
 * Clockin-Projektzeile, wie sie `searchForProjects` liefert. `employees`
 * kommt nur mit `includes:[{relation:"employees"}]` mit — genau dafür ist
 * dieser Prefetch da: er ersetzt ein `getAListOfProjectEmployees` je Projekt.
 */
export interface ClockinProjectRow {
  id?: number
  name?: string
  number?: string | null
  start_date?: string | null
  archived?: boolean
  employees?: { id?: number }[]
  customFields?: { custom_field_id?: number; value?: string | null }[]
}

/**
 * Vorab geladene Clockin-Projekte, indiziert nach Dimacon-Projektnummer.
 *
 * MEHRWERTIG (Map<Nummer, Zeile[]>): ein einwertiger Index würde jede
 * Mehrdeutigkeit still auf den ersten Treffer reduzieren. Die Aufrufer
 * entscheiden selbst, was sie mit mehreren Kandidaten tun.
 */
export interface ClockinProjectLookup {
  /** ALLE Zeilen zu dieser Dimacon-Projektnummer — nie nur die erste. */
  get(dimaconProjectId: string): ClockinProjectRow[]
  /** false ⇒ `byNumber` akzeptierte keine Sammelparameter, Einzel-Fallback lief */
  readonly bundled: boolean
  /** Zeilen im Index (Diagnose/Log) */
  readonly size: number
}

/**
 * Ids je Suchanfrage. Bewusst konservativ: die Clockin-Suche nimmt die
 * Parameter im Request-Body, aber eine dokumentierte Obergrenze gibt es
 * nicht — 25 hält den Body klein und die Zahl der Requests niedrig.
 */
export const PROJECT_LOOKUP_CHUNK_SIZE = 25

export interface ProjectLookupOptions {
  /** Custom-Field-Werte mitladen (nur nötig bei eigenen Ziel-Feldern) */
  withCustomFields?: boolean
  /** Mitarbeiter der Projekte mitladen (spart getAListOfProjectEmployees) */
  withEmployees?: boolean
  log?: Logger
  chunkSize?: number
}

interface SearchResponse {
  data?: ClockinProjectRow[]
}

/**
 * Lädt die Clockin-Projekte zu einer Liste von Dimacon-Projektnummern in
 * gebündelten `searchForProjects`-Aufrufen (statt einer Suche je Projekt).
 *
 * Ob der `byNumber`-Scope mehrere Parameter als ODER auswertet, ist NICHT
 * dokumentiert. Deshalb probt der erste gebündelte Aufruf das Verhalten:
 * trifft er Zeilen zu höchstens einer der angefragten Nummern, gilt die
 * Bündelung als nicht unterstützt und der gesamte Lauf schaltet auf
 * Einzelanfragen je Nummer um (`bundled: false`). Der Pfad ist damit in
 * beiden Fällen korrekt — nur unterschiedlich schnell.
 */
export async function loadClockinProjectsByNumber(
  client: ClockInClient,
  dimaconProjectIds: readonly string[],
  options: ProjectLookupOptions = {},
): Promise<ClockinProjectLookup> {
  const { log } = options
  const chunkSize = options.chunkSize ?? PROJECT_LOOKUP_CHUNK_SIZE
  const ids = [...new Set(dimaconProjectIds.filter((id) => id !== ""))]
  const index = new Map<string, ClockinProjectRow[]>()

  const wanted = new Set(ids.map(normalizeName))
  const search = async (parameters: string[]): Promise<ClockinProjectRow[]> => {
    const response = (await withRetry(() =>
      clockin.searchForProjects({
        client,
        body: {
          scopes: [{ name: "byNumber", parameters }],
          ...includes(options),
        },
      }),
    )) as unknown as SearchResponse
    return (response.data ?? []).filter((row) => row.id !== undefined)
  }

  /**
   * Zeilen den angefragten Nummern zuordnen. Bei EINER angefragten Nummer
   * gilt (wie in der bisherigen Einzelsuche) die Antwort selbst als Treffer
   * — der `byNumber`-Scope erlaubt Wildcards, eine leicht abweichende
   * Schreibweise der Nummer bliebe sonst unauffindbar und würde ein
   * Duplikat anlegen. Bei mehreren Nummern MUSS lokal nach `number`
   * gruppiert werden, sonst landen fremde Zeilen unter der falschen Nummer.
   */
  const assign = (parameters: string[], rows: ClockinProjectRow[]): number => {
    if (parameters.length === 1) {
      if (rows.length > 0) index.set(normalizeName(parameters[0]), rows)
      return rows.length > 0 ? 1 : 0
    }
    const hit = new Set<string>()
    for (const row of rows) {
      const key = normalizeName(row.number)
      if (!key || !wanted.has(key)) continue
      const list = index.get(key) ?? []
      list.push(row)
      index.set(key, list)
      hit.add(key)
    }
    return hit.size
  }

  if (ids.length === 0) return lookup(index, true)

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize))

  // Probe: der erste Sammel-Chunk belegt (oder widerlegt), dass `byNumber`
  // mehrere Parameter auswertet.
  const probeChunk = chunks[0]
  const probeRows = await search(probeChunk)
  const distinct = assign(probeChunk, probeRows)
  // Keine Zeile heißt: nichts belegt und nichts widerlegt — typisch beim
  // Erstlauf, wenn fast alle Projekte neu sind. Dann weiter bündeln, sonst
  // fällt genau der Lauf mit den meisten Projekten auf Einzelsuchen zurück.
  if (probeChunk.length > 1 && probeRows.length > 0 && distinct <= 1) {
    log?.warn("clockin byNumber does not appear to accept multiple parameters — per-id lookups", {
      probed: probeChunk.length,
      matched: distinct,
    })
    index.clear()
    await runSingles(ids, search, assign)
    return lookup(index, false)
  }

  const limit = createLimit("clockin")
  await Promise.all(
    chunks.slice(1).map((chunk) => limit(async () => void assign(chunk, await search(chunk)))),
  )

  return lookup(index, true)
}

async function runSingles(
  ids: readonly string[],
  search: (parameters: string[]) => Promise<ClockinProjectRow[]>,
  assign: (parameters: string[], rows: ClockinProjectRow[]) => number,
): Promise<void> {
  const limit = createLimit("clockin")
  await Promise.all(ids.map((id) => limit(async () => void assign([id], await search([id])))))
}

function includes(options: ProjectLookupOptions) {
  const relations: { relation: "employees" | "customFields" }[] = []
  if (options.withEmployees !== false) relations.push({ relation: "employees" })
  if (options.withCustomFields) relations.push({ relation: "customFields" })
  return relations.length > 0 ? { includes: relations } : {}
}

function lookup(index: Map<string, ClockinProjectRow[]>, bundled: boolean): ClockinProjectLookup {
  return {
    get: (dimaconProjectId) => index.get(normalizeName(dimaconProjectId)) ?? [],
    bundled,
    size: [...index.values()].reduce((sum, rows) => sum + rows.length, 0),
  }
}
