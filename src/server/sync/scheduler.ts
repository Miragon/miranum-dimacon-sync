import { Cron } from "croner"
import { env } from "../lib/env.js"
import { formatError } from "../lib/errors.js"
import { log } from "../lib/log.js"
import { runSync } from "./index.js"
import { SyncBusyError } from "./mutex.js"

let cron: Cron | undefined

export function startScheduler(): void {
  const schedule = env.sync.cron()
  if (!schedule) {
    log.info("sync cron disabled (SYNC_CRON not set)")
    return
  }

  const tz = env.sync.timezone()
  cron = new Cron(schedule, { timezone: tz, protect: true }, async () => {
    log.info("scheduled sync trigger", { schedule, tz })
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

  const next = cron.nextRun()
  log.info("sync cron scheduled", { schedule, tz, nextRun: next?.toISOString() ?? null })
}

export function stopScheduler(): void {
  cron?.stop()
  cron = undefined
}
