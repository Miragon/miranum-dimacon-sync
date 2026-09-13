import { and, eq, notInArray, sql } from "drizzle-orm"
import { log } from "../../lib/log.js"
import { formatError } from "../../lib/errors.js"
import { getDb } from "../client.js"
import { syncRuns } from "../schema.js"

export type RunTrigger = "manual" | "cron" | "webhook" | "mcp"
// "skipped": aufgezeichnet, aber NIE gestartet (fail-closed übersprungener
// Cron). `dryRun`/`input` solcher Zeilen sind nur NOT-NULL-Platzhalter und
// beschreiben weder Modus noch Umfang — die Historie blendet beides aus.
export type RunStatus = "success" | "error" | "skipped"

const KEEP_RUNS = 50
// Ergebnisse jenseits dieser Größe werden nicht persistiert (jsonb-Bloat).
const MAX_RESULT_BYTES = 512 * 1024

export interface RunRecord {
  tenantId: string
  integrationId: string
  trigger: RunTrigger
  status: RunStatus
  dryRun: boolean
  input: unknown
  result?: unknown
  error?: string
  startedAt: Date
  finishedAt: Date
}

/** Zeile der Run-Historie — bewusst OHNE `result` (jsonb-Größe). */
export interface RunSummary {
  id: string
  trigger: RunTrigger
  status: "running" | "success" | "error" | "skipped"
  dryRun: boolean
  input: unknown
  error: string | null
  startedAt: Date
  durationMs: number | null
}

/** Obergrenze der Historie-Abfrage — passt zur Retention (KEEP_RUNS). */
const MAX_LIST_LIMIT = 50

/**
 * Run-Historie eines (Mandant, Integration)-Slots, neueste zuerst.
 * LOAD-BEARING: tenant-gescopt — Läufe sind Mandantendaten.
 */
export async function listRuns(
  tenantId: string,
  integrationId: string,
  limit = 20,
): Promise<RunSummary[]> {
  const rows = await getDb()
    .select({
      id: syncRuns.id,
      trigger: syncRuns.trigger,
      status: syncRuns.status,
      dryRun: syncRuns.dryRun,
      input: syncRuns.input,
      error: syncRuns.error,
      startedAt: syncRuns.startedAt,
      durationMs: syncRuns.durationMs,
    })
    .from(syncRuns)
    .where(and(eq(syncRuns.tenantId, tenantId), eq(syncRuns.integrationId, integrationId)))
    .orderBy(sql`${syncRuns.startedAt} DESC`)
    .limit(Math.min(Math.max(1, limit), MAX_LIST_LIMIT))
  return rows
}

/**
 * Persistiert einen abgeschlossenen Lauf + Retention (letzte 50 je
 * (Mandant, Integration) — beide DELETE-Klauseln tenant-gescopt, sonst
 * würde die Retention fremde Mandanten-Historie löschen). Fehler beim
 * Aufzeichnen dürfen den Lauf selbst nie scheitern lassen.
 */
export async function recordRun(record: RunRecord): Promise<void> {
  try {
    const db = getDb()
    let result = record.result ?? null
    // Buffer.byteLength statt .length: UTF-16-Code-Units unterschätzen
    // Multi-Byte-Inhalte — das Cap soll echte Bytes begrenzen.
    if (result !== null && Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
      // Die Lauf-Metrik überlebt die Kürzung: gerade die großen Läufe sind
      // die interessanten, ihre Phasen-Timings dürfen nicht wegfallen.
      const metrics = (record.result as { metrics?: unknown } | null | undefined)?.metrics
      result = metrics === undefined ? { truncated: true } : { truncated: true, metrics }
    }
    await db.insert(syncRuns).values({
      tenantId: record.tenantId,
      integrationId: record.integrationId,
      trigger: record.trigger,
      status: record.status,
      dryRun: record.dryRun,
      input: record.input ?? {},
      result,
      error: record.error ?? null,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.finishedAt.getTime() - record.startedAt.getTime(),
    })

    const keep = db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.tenantId, record.tenantId),
          eq(syncRuns.integrationId, record.integrationId),
        ),
      )
      .orderBy(sql`${syncRuns.startedAt} DESC`)
      .limit(KEEP_RUNS)
    await db
      .delete(syncRuns)
      .where(
        and(
          eq(syncRuns.tenantId, record.tenantId),
          eq(syncRuns.integrationId, record.integrationId),
          notInArray(syncRuns.id, keep),
        ),
      )
  } catch (err) {
    log.warn("sync run not recorded", {
      tenant: record.tenantId,
      integration: record.integrationId,
      error: formatError(err),
    })
  }
}
