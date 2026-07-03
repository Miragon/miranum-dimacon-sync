import { Cron } from "croner"
import { getScheduleSettings } from "../lib/settings.js"
import { formatError } from "../lib/errors.js"
import { log } from "../lib/log.js"
import { SyncBusyError } from "./mutex.js"
import { getIntegration, integrations, runIntegration } from "./registry.js"

const crons = new Map<string, Cron>()

/** Startet (bzw. restartet) die Crons aller registrierten Integrationen. */
export async function startScheduler(): Promise<void> {
  for (const def of integrations) {
    await startIntegrationCron(def.id)
  }
}

/** Startet den Cron einer einzelnen Integration neu (z. B. nach Settings-PUT). */
export async function startIntegrationCron(id: string): Promise<void> {
  crons.get(id)?.stop()
  crons.delete(id)

  const def = getIntegration(id)
  if (!def) return

  const settings = await getScheduleSettings(id)
  if (!settings.enabled || !settings.cron) {
    log.info("integration cron disabled", {
      integration: id,
      enabled: settings.enabled,
      hasCron: Boolean(settings.cron),
    })
    return
  }

  try {
    const cron = new Cron(
      settings.cron,
      { timezone: settings.timezone, protect: true },
      async () => {
        log.info("scheduled run trigger", {
          integration: id,
          schedule: settings.cron,
          tz: settings.timezone,
        })
        try {
          await runIntegration(def, def.inputSchema.parse({}))
        } catch (err) {
          if (err instanceof SyncBusyError) {
            log.warn("scheduled run skipped: another run in progress", { integration: id })
            return
          }
          log.error("scheduled run failed", { integration: id, error: formatError(err) })
        }
      },
    )
    crons.set(id, cron)
    log.info("integration cron scheduled", {
      integration: id,
      schedule: settings.cron,
      tz: settings.timezone,
      nextRun: cron.nextRun()?.toISOString() ?? null,
    })
  } catch (err) {
    log.error("integration cron start failed", { integration: id, error: formatError(err) })
  }
}

export function stopScheduler(): void {
  for (const cron of crons.values()) cron.stop()
  crons.clear()
}

export function getNextRun(id: string): string | null {
  return crons.get(id)?.nextRun()?.toISOString() ?? null
}

export function isCronActive(id: string): boolean {
  return crons.has(id)
}
