import { recordRun } from "../db/repos/sync-runs.js"
import { formatError } from "../lib/errors.js"
import { dimaconClockinIntegration } from "./dimacon-clockin/index.js"
import { dimaconLexofficeIntegration } from "./dimacon-lexoffice/index.js"
import { runExclusive } from "./mutex.js"
import type { IntegrationDefinition, IntegrationRunContext } from "./types.js"

/** Alle verfügbaren Integrationen — eine pro Zielsystem. */
export const integrations: readonly IntegrationDefinition[] = [
  dimaconClockinIntegration,
  dimaconLexofficeIntegration,
]

export function getIntegration(id: string): IntegrationDefinition | undefined {
  return integrations.find((i) => i.id === id)
}

/**
 * Zentraler Einstiegspunkt für Läufe (Routes + Scheduler): je (Mandant,
 * Integration) läuft maximal ein Run gleichzeitig, sonst SyncBusyError.
 * Jeder abgeschlossene Lauf landet in sync_runs (recordRun wirft nie).
 */
export async function runIntegration(
  def: IntegrationDefinition,
  ctx: IntegrationRunContext,
  input: unknown,
): Promise<unknown> {
  return runExclusive(ctx.tenantId, def.id, async () => {
    const startedAt = new Date()
    const dryRun = Boolean((input as { dryRun?: boolean } | null | undefined)?.dryRun)
    try {
      const result = await def.run(ctx, input)
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
