import { Cron } from "croner"
import { getSyncSettings } from "../lib/settings.js"
import { formatError } from "../lib/errors.js"
import { log } from "../lib/log.js"
import { runSync } from "./index.js"
import { SyncBusyError } from "./mutex.js"

let cron: Cron | undefined

export async function startScheduler(): Promise<void> {
  stopScheduler()
  const settings = await getSyncSettings()
  if (!settings.enabled || !settings.cron) {
    log.info("sync cron disabled", {
      enabled: settings.enabled,
      hasCron: Boolean(settings.cron),
    })
    return
  }

  try {
    cron = new Cron(settings.cron, { timezone: settings.timezone, protect: true }, async () => {
      log.info("scheduled sync trigger", {
        schedule: settings.cron,
        tz: settings.timezone,
      })
      try {
        await runSync({})
      } catch (err) {
        if (err instanceof SyncBusyError) {
          log.warn("scheduled sync skipped: another run in progress")
          return
        }
        log.error("scheduled sync failed", { error: formatError(err) })
      }
    })
    log.info("sync cron scheduled", {
      schedule: settings.cron,
      tz: settings.timezone,
      nextRun: cron.nextRun()?.toISOString() ?? null,
    })
  } catch (err) {
    cron = undefined
    log.error("sync cron start failed", { error: formatError(err) })
  }
}

export function stopScheduler(): void {
  cron?.stop()
  cron = undefined
}

export function getNextRun(): string | null {
  return cron?.nextRun()?.toISOString() ?? null
}

export function isCronActive(): boolean {
  return cron !== undefined
}
