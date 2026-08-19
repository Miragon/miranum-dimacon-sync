import { and, eq } from "drizzle-orm"
import {
  DEFAULT_SCHEDULE,
  ScheduleSettingsSchema,
  type ScheduleSettings,
} from "../../lib/schedule-schema.js"
import { getDb } from "../client.js"
import { scheduleSettings, tenants } from "../schema.js"

export async function getScheduleSettings(
  tenantId: string,
  integrationId: string,
): Promise<ScheduleSettings> {
  const rows = await getDb()
    .select()
    .from(scheduleSettings)
    .where(
      and(
        eq(scheduleSettings.tenantId, tenantId),
        eq(scheduleSettings.integrationId, integrationId),
      ),
    )
    .limit(1)
  const row = rows[0]
  // Kopie statt Singleton-Referenz: eine spätere In-Place-Mutation beim
  // Aufrufer darf nicht den Default aller Mandanten korrumpieren.
  if (!row) return { ...DEFAULT_SCHEDULE }
  return ScheduleSettingsSchema.parse({
    enabled: row.enabled,
    cron: row.cron ?? undefined,
    timezone: row.timezone,
  })
}

export async function updateScheduleSettings(
  tenantId: string,
  integrationId: string,
  input: ScheduleSettings,
): Promise<ScheduleSettings> {
  const values = {
    tenantId,
    integrationId,
    enabled: input.enabled,
    cron: input.cron ?? null,
    timezone: input.timezone,
  }
  await getDb()
    .insert(scheduleSettings)
    .values(values)
    .onConflictDoUpdate({
      target: [scheduleSettings.tenantId, scheduleSettings.integrationId],
      set: {
        enabled: values.enabled,
        cron: values.cron,
        timezone: values.timezone,
        updatedAt: new Date(),
      },
    })
  return input
}

export interface EnabledSchedule {
  tenantId: string
  integrationId: string
  settings: ScheduleSettings
}

/** Alle aktivierten Schedules aktiver Mandanten — Boot-Input des Schedulers. */
export async function listEnabledSchedules(): Promise<EnabledSchedule[]> {
  const rows = await getDb()
    .select({
      tenantId: scheduleSettings.tenantId,
      integrationId: scheduleSettings.integrationId,
      enabled: scheduleSettings.enabled,
      cron: scheduleSettings.cron,
      timezone: scheduleSettings.timezone,
    })
    .from(scheduleSettings)
    .innerJoin(tenants, eq(scheduleSettings.tenantId, tenants.id))
    .where(and(eq(scheduleSettings.enabled, true), eq(tenants.active, true)))
  return rows
    .filter((r) => r.cron)
    .map((r) => ({
      tenantId: r.tenantId,
      integrationId: r.integrationId,
      settings: { enabled: r.enabled, cron: r.cron ?? undefined, timezone: r.timezone },
    }))
}
