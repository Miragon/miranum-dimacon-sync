import { recordRun } from "../db/repos/sync-runs.js"
import { formatError } from "../lib/errors.js"
import { withRunMetrics, type RunMetricsSnapshot } from "../lib/metrics.js"
import { dimaconClockinIntegration } from "./dimacon-clockin/index.js"
import { dimaconLexofficeIntegration } from "./dimacon-lexoffice/index.js"
import { dimaconSevdeskIntegration } from "./dimacon-sevdesk/index.js"
import { runExclusive } from "./mutex.js"
import type { IntegrationDefinition, IntegrationRunContext } from "./types.js"

/** Alle verfügbaren Integrationen — eine pro Zielsystem. */
export const integrations: readonly IntegrationDefinition[] = [
  dimaconClockinIntegration,
  dimaconLexofficeIntegration,
  dimaconSevdeskIntegration,
]

export function getIntegration(id: string): IntegrationDefinition | undefined {
  return integrations.find((i) => i.id === id)
}

/**
 * Zentraler Einstiegspunkt für Läufe (Routes + Scheduler): je (Mandant,
 * Integration) läuft maximal ein Run gleichzeitig, sonst SyncBusyError.
 * Jeder abgeschlossene Lauf landet in sync_runs (recordRun wirft nie).
 *
 * Zusätzlich öffnet er den Metrik-Scope (withRunMetrics): Phasen-Dauern und
 * Request-Zähler landen ohne Plumbing im Log UND — bei Objekt-Ergebnissen —
 * als `metrics` im persistierten Ergebnis.
 */
export async function runIntegration(
  def: IntegrationDefinition,
  ctx: IntegrationRunContext,
  input: unknown,
): Promise<unknown> {
  return runExclusive(ctx.tenantId, def.id, async () => {
    const startedAt = new Date()
    const dryRun = Boolean((input as { dryRun?: boolean } | null | undefined)?.dryRun)
    let metrics: RunMetricsSnapshot | undefined
    try {
      const raw = await withRunMetrics(
        () => def.run(ctx, input),
        (snapshot) => (metrics = snapshot),
      )
      if (metrics) ctx.log.info("integration run metrics", { integration: def.id, metrics })
      const result = attachMetrics(raw, metrics)
      await recordRun({
        tenantId: ctx.tenantId,
        integrationId: def.id,
        trigger: ctx.trigger,
        status: "success",
        dryRun,
        input,
        result,
        startedAt,
        finishedAt: new Date(),
      })
      return result
    } catch (err) {
      // Auch der Fehlerpfad meldet die Zahlen — gerade abgebrochene Läufe
      // sind die interessanten (Rate-Limit-Wartezeiten, Request-Zähler).
      if (metrics) ctx.log.info("integration run metrics", { integration: def.id, metrics })
      await recordRun({
        tenantId: ctx.tenantId,
        integrationId: def.id,
        trigger: ctx.trigger,
        status: "error",
        dryRun,
        input,
        error: formatError(err),
        startedAt,
        finishedAt: new Date(),
      })
      throw err
    }
  })
}

/**
 * Metriken generisch ans Ergebnis hängen — nur bei Plain-Objects, damit
 * Arrays/primitive Ergebnisse künftiger Integrationen unangetastet bleiben.
 * Ein bereits vorhandenes `metrics`-Feld der Integration gewinnt nicht:
 * die gemessenen Werte sind autoritativ.
 */
function attachMetrics(result: unknown, metrics: RunMetricsSnapshot | undefined): unknown {
  if (!metrics) return result
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result
  return { ...(result as Record<string, unknown>), metrics }
}
