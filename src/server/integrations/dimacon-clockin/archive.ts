import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { createLimit, withRetry } from "../../lib/concurrency.js"
import { env } from "../../lib/env.js"
import { formatError } from "../../lib/errors.js"
import type { Logger } from "../../lib/log.js"
import { clockinPageQuery, loadAllClockinPages } from "../shared/clockin-pages.js"
import type { ClockinPage } from "../shared/clockin-pages.js"
import { normalizeName } from "../shared/matching.js"
import type { ArchiveResult } from "./types.js"

interface ClockinProjectRow {
  id?: number
  name?: string
  number?: string | null
}

/** Query-Typ der Projektsuche — trägt den `page`-Parameter nicht (s. clockinPageQuery). */
type ProjectSearchQuery = NonNullable<Parameters<typeof clockin.searchForProjects>[0]>["query"]

/**
 * Planungshorizont des Archiv-Schutzes in Tagen — VORWÄRTS UND RÜCKWÄRTS um
 * das Sync-Datum. Ein Projekt wird nur archiviert, wenn es in diesem ganzen
 * Fenster keinen Termin hat.
 *
 * Pflicht, nicht Kür: die Phase liest seit #15 ALLE Seiten des Clockin-
 * Bestands statt nur der ersten — ohne Horizont pendelten wiederkehrende
 * Projekte täglich zwischen archiviert und aktiv (zwei Schreibvorgänge pro
 * Projekt und Tag, ohne fachliche Änderung), und der erste Lauf archivierte
 * schlagartig alles, was heute gerade nicht eingeplant ist. 14 Tage decken
 * den üblichen Planungsvorlauf ab; per `ARCHIVE_HORIZON_DAYS` anpassbar.
 */
export const DEFAULT_ARCHIVE_HORIZON_DAYS = 14

/**
 * Einziger Env-Zugriff des Integrations-Codes — analog zu `createLimit`,
 * das die Parallelität ebenfalls aus der Env liest. Der Wert ist Ops-Tuning,
 * kein Mandanten-Zustand.
 */
export function archiveHorizonDays(): number {
  return env.archiveHorizonDays(DEFAULT_ARCHIVE_HORIZON_DAYS)
}

export interface ArchiveOptions {
  /** Clockin-Ids, die dieser Lauf aufgelöst oder angelegt hat */
  syncedClockinProjectIds: ReadonlySet<number>
  /** Dimacon-Projektnummern mit einem Termin im Planungshorizont */
  horizonProjectNumbers: ReadonlySet<string>
  /**
   * false = der Horizont konnte nicht ermittelt werden. Dann wird NICHTS
   * archiviert — lieber zu wenig archivieren als auf halber Datenbasis.
   */
  horizonComplete: boolean
  dryRun: boolean
  /**
   * Wird gerufen, wenn die Phase ohne einen einzigen Schreibvorgang abbricht.
   * Der Grund gehört ins Lauf-Ergebnis — sonst ist „Schutz hat gegriffen"
   * nicht von „es gab nichts zu archivieren" zu unterscheiden.
   */
  onSkipped?: (reason: string) => void
  /** Fehler eines einzelnen Projekts; die Phase läuft weiter. */
  onError?: (clockinProjectId: number, message: string) => void
}

/**
 * Archiviert Clockin-Projekte, die weder heute eingeplant sind noch im
 * Planungshorizont einen Termin haben.
 *
 * Bewusst benanntes Options-Objekt: die beiden Schutzmengen sind
 * gleichgeformt genug, dass vertauschte Positionsargumente für den Compiler
 * identisch aussähen und der Schutz still wirkungslos wäre.
 */
export async function archiveUnplanned(
  client: ClockInClient,
  options: ArchiveOptions,
  log: Logger,
): Promise<ArchiveResult[]> {
  const { syncedClockinProjectIds, horizonProjectNumbers, horizonComplete, dryRun } = options

  if (!horizonComplete) {
    log.warn("archive phase skipped — planning horizon unknown", {
      horizonProjects: horizonProjectNumbers.size,
    })
    return []
  }

  const loaded = await loadAllClockinPages<ClockinProjectRow>({
    fetchPage: (page) =>
      withRetry(() =>
        clockin.searchForProjects({
          client,
          body: { scopes: [{ name: "unarchived" }] },
          query: clockinPageQuery<NonNullable<ProjectSearchQuery>>(page),
        }),
      ) as unknown as Promise<ClockinPage<ClockinProjectRow>>,
    idOf: (r) => r.id,
    log,
    label: "clockin unarchived projects",
  })

  if (!loaded.complete) {
    // Fail-safe: auf halber Datenbasis würde die Phase Projekte archivieren,
    // deren Schutzinformation auf einer nicht geladenen Seite steht.
    const reason = `Clockin-Projektliste unvollständig geladen${
      loaded.reason ? ` (${loaded.reason})` : ""
    } — es wurde nichts archiviert`
    log.warn("archive phase skipped — unarchived project list incomplete", {
      reason: loaded.reason,
      rows: loaded.rows.length,
    })
    options.onSkipped?.(reason)
    return []
  }

  let withoutNumber = 0
  const candidates = loaded.rows.filter((row) => {
    if (row.id === undefined) return false
    if (syncedClockinProjectIds.has(row.id)) return false
    // Ohne Dimacon-Nummer stammt das Projekt nicht aus diesem Sync — `buildBody`
    // schreibt dort immer die Dimacon-Projekt-ID. Solche Zeilen sind in Clockin
    // von Hand angelegt und wären sonst dauerhaft Archiv-Kandidaten, seit die
    // Phase über ALLE Seiten statt nur der ersten läuft.
    if (normalizeName(row.number) === "") {
      withoutNumber += 1
      return false
    }
    return !horizonProjectNumbers.has(normalizeName(row.number))
  })

  log.info("archive phase candidates", {
    unarchived: loaded.rows.length,
    pages: loaded.pages,
    protectedBySync: syncedClockinProjectIds.size,
    protectedByHorizon: horizonProjectNumbers.size,
    skippedWithoutNumber: withoutNumber,
    toArchive: candidates.length,
  })

  if (dryRun) {
    for (const row of candidates) {
      log.info("[dryRun] would archive project", { clockinProjectId: row.id, name: row.name })
    }
    return candidates.map((row) => ({ clockinProjectId: row.id!, name: row.name ?? "" }))
  }

  const limit = createLimit("clockin")
  // allSettled statt all: ein einzelner fehlgeschlagener Schreibvorgang darf
  // nicht die Liste der bereits archivierten Projekte verwerfen — sonst meldet
  // der Lauf „0 archiviert", während in Clockin N Projekte archiviert sind.
  const settled = await Promise.allSettled(
    candidates.map((row) =>
      limit(async () => {
        await withRetry(() =>
          clockin.updateProject({
            client,
            path: { project: row.id! },
            // `number` mitschicken: bei Replace-Semantik des Updates würde die
            // Projektnummer sonst genullt — die Auflösung fände das Projekt am
            // Folgetag nicht mehr und legte ein Duplikat an.
            body: { name: row.name ?? "", number: row.number ?? null, archived: true },
          }),
        )
        return { clockinProjectId: row.id!, name: row.name ?? "" } satisfies ArchiveResult
      }),
    ),
  )

  const archived: ArchiveResult[] = []
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      archived.push(result.value)
      return
    }
    const message = formatError(result.reason)
    const clockinProjectId = candidates[i]!.id!
    log.error("archiving a project failed", { clockinProjectId, error: message })
    options.onError?.(clockinProjectId, message)
  })

  return archived
}
