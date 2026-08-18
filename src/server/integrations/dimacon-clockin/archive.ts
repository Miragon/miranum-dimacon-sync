import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import type { ArchiveResult } from "./types.js"

interface ClockinProjectRow {
  id?: number
  name?: string
  number?: string | null
}

interface ClockinSearchProjectsResponse {
  data?: ClockinProjectRow[]
  meta?: { current_page?: number; last_page?: number; per_page?: number; total?: number }
}

export async function archiveUnplanned(
  client: ClockInClient,
  syncedClockinProjectIds: Set<number>,
  log: Logger,
  dryRun: boolean,
): Promise<ArchiveResult[]> {
  const archived: ArchiveResult[] = []

  const response = (await withRetry(() =>
    clockin.searchForProjects({
      client,
      body: { scopes: [{ name: "unarchived" }] },
    }),
  )) as unknown as ClockinSearchProjectsResponse

  const meta = response.meta
  if (meta?.last_page && meta.last_page > 1) {
    log.warn("clockin unarchived projects exceed first page; archive may be incomplete", {
      total: meta.total,
      lastPage: meta.last_page,
      perPage: meta.per_page,
    })
  }

  const rows = response.data ?? []
  for (const row of rows) {
    if (row.id === undefined) continue
    if (syncedClockinProjectIds.has(row.id)) continue

    if (dryRun) {
      log.info("[dryRun] would archive project", { clockinProjectId: row.id, name: row.name })
      archived.push({ clockinProjectId: row.id, name: row.name ?? "" })
      continue
    }

    await withRetry(() =>
      clockin.updateProject({
        client,
        path: { project: row.id! },
        // `number` mitschicken: bei Replace-Semantik des Updates würde die
        // Projektnummer sonst genullt — findByNumber fände das Projekt am
        // Folgetag nicht mehr und legte ein Duplikat an.
        body: { name: row.name ?? "", number: row.number ?? null, archived: true },
      }),
    )
    archived.push({ clockinProjectId: row.id, name: row.name ?? "" })
  }

  return archived
}
