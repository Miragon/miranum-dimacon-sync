import { Cron } from "croner"
import { getScheduleSettings, listEnabledSchedules } from "../db/repos/schedules.js"
import { getTenantById } from "../db/repos/tenants.js"
import { formatError } from "../lib/errors.js"
import { log } from "../lib/log.js"
import type { ScheduleSettings } from "../lib/schedule-schema.js"
import { buildRunContext } from "./context.js"
import { SyncBusyError } from "./mutex.js"
import { getIntegration, runIntegration } from "./registry.js"
import { missingCredentials } from "./types.js"

// Ein Cron-Slot je (Mandant, Integration).
const crons = new Map<string, Cron>()

function key(tenantId: string, integrationId: string): string {
  return `${tenantId} ${integrationId}`
}

/** Startet die Crons aller aktivierten Schedules aktiver Mandanten. */
export async function startScheduler(): Promise<void> {
  for (const entry of await listEnabledSchedules()) {
    startCron(entry.tenantId, entry.integrationId, entry.settings)
  }
}

/** Startet den Cron eines (Mandant, Integration)-Slots neu (Settings-PUT). */
export async function startTenantIntegrationCron(
  tenantId: string,
  integrationId: string,
): Promise<void> {
  const k = key(tenantId, integrationId)
  crons.get(k)?.stop()
  crons.delete(k)

  if (!getIntegration(integrationId)) return

  const settings = await getScheduleSettings(tenantId, integrationId)
  if (!settings.enabled || !settings.cron) {
    log.info("integration cron disabled", {
      tenant: tenantId,
      integration: integrationId,
      enabled: settings.enabled,
      hasCron: Boolean(settings.cron),
    })
    return
  }
  startCron(tenantId, integrationId, settings)
}

function startCron(tenantId: string, integrationId: string, settings: ScheduleSettings): void {
  const def = getIntegration(integrationId)
  if (!def || !settings.cron) return
  const k = key(tenantId, integrationId)
  crons.get(k)?.stop()

  try {
    const cron = new Cron(
      settings.cron,
      { timezone: settings.timezone, protect: true },
      async () => {
        log.info("scheduled run trigger", {
          tenant: tenantId,
          integration: integrationId,
          schedule: settings.cron,
          tz: settings.timezone,
        })
        try {
          // Tenant + Credentials ZUR FEUERZEIT prüfen: Mandanten-
          // Deaktivierung hat bewusst keinen eigenen Stop-Hook — dieser
          // Check ist die einzige Wache gegen Läufe deaktivierter Mandanten.
          const tenant = await getTenantById(tenantId)
          if (!tenant || !tenant.active) {
            log.warn("scheduled run skipped: tenant inactive", { tenant: tenantId })
            return
          }
          const missing = await missingCredentials(def, tenantId)
          if (missing.length > 0) {
            log.warn("scheduled run skipped: not configured", { tenant: tenantId, missing })
            return
          }
          await runIntegration(def, buildRunContext(def, tenant, "cron"), def.inputSchema.parse({}))
        } catch (err) {
          if (err instanceof SyncBusyError) {
            log.warn("scheduled run skipped: another run in progress", {
              tenant: tenantId,
              integration: integrationId,
            })
            return
          }
          log.error("scheduled run failed", {
            tenant: tenantId,
            integration: integrationId,
            error: formatError(err),
          })
        }
      },
    )
    crons.set(k, cron)
    log.info("integration cron scheduled", {
      tenant: tenantId,
      integration: integrationId,
      schedule: settings.cron,
      tz: settings.timezone,
      nextRun: cron.nextRun()?.toISOString() ?? null,
    })
  } catch (err) {
    log.error("integration cron start failed", {
      tenant: tenantId,
      integration: integrationId,
      error: formatError(err),
    })
  }
}

export function stopScheduler(): void {
  for (const cron of crons.values()) cron.stop()
  crons.clear()
}

export function getNextRun(tenantId: string, integrationId: string): string | null {
  return crons.get(key(tenantId, integrationId))?.nextRun()?.toISOString() ?? null
}

export function isCronActive(tenantId: string, integrationId: string): boolean {
  return crons.has(key(tenantId, integrationId))
}
