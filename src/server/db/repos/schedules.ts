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

/**
 * jsonb liefert zur Laufzeit alles, was in der Spalte steht — nur ein echtes
 * Objekt taugt als Umfang. Die Kopie verhindert, dass eine Mutation beim
 * Aufrufer in einen späteren Lauf durchschlägt.
 */
function asScopeObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value }
    : undefined
}

/**
 * ROHWERT der Spalte `run_defaults` je (Mandant, Integration) — Basis der
 * Lauf-Auflösung und deshalb bewusst `unknown`: ein per SQL eingeschleustes
 * Nicht-Objekt (Array, Zahl, String, jsonb `null`) darf NICHT zu `{}`
 * geglättet werden, sonst liefe der Lauf mit den vollen Schema-Defaults
 * („alles an, live") statt fail-closed abzubrechen. Nur „keine Zeile" ergibt
 * `undefined` — der Normalfall, der nichts blockieren darf. Wird zur
 * FEUERZEIT gelesen, nicht beim Cron-Start eingefroren.
 */
export async function getStoredRunDefaults(
  tenantId: string,
  integrationId: string,
): Promise<unknown> {
  const rows = await getDb()
    .select({ runDefaults: scheduleSettings.runDefaults })
    .from(scheduleSettings)
    .where(
      and(
        eq(scheduleSettings.tenantId, tenantId),
        eq(scheduleSettings.integrationId, integrationId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return undefined
  // Nicht-Objekte gehen UNVERÄNDERT raus, damit der Aufrufer sie ablehnen kann.
  return asScopeObject(row.runDefaults) ?? row.runDefaults
}

/**
 * Anzeigeform für die Status-/Settings-API: `{}` = keine Zeile bzw. nie
 * gespeichert (exakt das alte Verhalten, Zod-Defaults) und defensiv auch für
 * einen kaputten Wert — Läufe blockiert `loadRunDefaults` fail-closed, die
 * Statusliste soll daran nicht scheitern. NICHT für Läufe verwenden.
 */
export async function getRunDefaults(
  tenantId: string,
  integrationId: string,
): Promise<Record<string, unknown>> {
  return asScopeObject(await getStoredRunDefaults(tenantId, integrationId)) ?? {}
}

/**
 * Speichert den (bereits gegen `def.inputSchema` validierten und von
 * flüchtigen Keys befreiten) Run-Umfang. Beim Insert bleiben
 * enabled/cron/timezone auf den DB-Defaults — der Umfang ist unabhängig
 * vom Zeitplan konfigurierbar.
 */
export async function updateRunDefaults(
  tenantId: string,
  integrationId: string,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await getDb()
    .insert(scheduleSettings)
    .values({ tenantId, integrationId, runDefaults: value })
    .onConflictDoUpdate({
      target: [scheduleSettings.tenantId, scheduleSettings.integrationId],
      set: { runDefaults: value, updatedAt: new Date() },
    })
  return value
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
      // LOAD-BEARING: `runDefaults` steht bewusst NICHT in dieser Liste —
      // sonst würde jedes Zeitplan-Speichern den konfigurierten Run-Umfang
      // überschreiben (eigener Endpoint, eigener Tab).
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
