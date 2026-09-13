import { Cron } from "croner"
import { Hono } from "hono"
import { z } from "zod"
import {
  getRunDefaults,
  getScheduleSettings,
  updateRunDefaults,
  updateScheduleSettings,
} from "../db/repos/schedules.js"
import { safeJson } from "../lib/http.js"
import { log } from "../lib/log.js"
import { ScheduleSettingsSchema, type ScheduleSettings } from "../lib/schedule-schema.js"
import type { AppEnv } from "../lib/tenant.js"
import { getIntegration, integrations } from "../integrations/registry.js"
import { parseRunDefaults } from "../integrations/run-input.js"
import { getNextRun, isCronActive, startTenantIntegrationCron } from "../integrations/scheduler.js"

const app = new Hono<AppEnv>()

app.get("/integrations", async (c) => {
  const tenant = c.get("tenant")
  const entries = await Promise.all(
    integrations.map(async (def) => {
      const [settings, runDefaults] = await Promise.all([
        getScheduleSettings(tenant.id, def.id),
        getRunDefaults(tenant.id, def.id),
      ])
      return scheduleEntry(tenant.id, def.id, def.name, settings, runDefaults)
    }),
  )
  return c.json(entries)
})

app.put("/integrations/:id", async (c) => {
  const tenant = c.get("tenant")
  const id = c.req.param("id")
  const def = getIntegration(id)
  if (!def) return c.json({ error: "unknown integration" }, 404)

  const raw = await safeJson(c.req.raw)
  const parsed = ScheduleSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: "invalid input", details: parsed.error.flatten() }, 400)
  }
  const input = parsed.data

  if (input.enabled && !input.cron) {
    return c.json({ error: "cron expression required when schedule is enabled" }, 400)
  }
  if (input.cron) {
    const v = validateCron(input.cron, input.timezone)
    if (!v.ok) return c.json({ error: v.message }, 400)
  }

  const saved = await updateScheduleSettings(tenant.id, id, input)
  await startTenantIntegrationCron(tenant.id, id)
  log.info("integration schedule updated", {
    tenant: tenant.id,
    integration: id,
    enabled: saved.enabled,
    cron: saved.cron ?? null,
    tz: saved.timezone,
  })
  // Der Umfang (run_defaults) wird hier bewusst NICHT angefasst — er hat
  // einen eigenen Endpoint; `updateScheduleSettings` lässt die Spalte stehen.
  return c.json(scheduleEntry(tenant.id, id, def.name, saved, await getRunDefaults(tenant.id, id)))
})

const RunDefaultsBodySchema = z.object({ runDefaults: z.record(z.string(), z.unknown()) })

/**
 * Persistenter Run-Umfang je (Mandant, Integration) — gilt für Cron,
 * manuelle Läufe und Webhooks. Validiert generisch gegen das `inputSchema`
 * der Integration und speichert die normalisierte, datumsfreie Form.
 * KEIN Cron-Restart nötig: der Scheduler liest den Umfang zur Feuerzeit.
 */
app.put("/integrations/:id/run-defaults", async (c) => {
  const tenant = c.get("tenant")
  const id = c.req.param("id")
  const def = getIntegration(id)
  if (!def) return c.json({ error: "unknown integration" }, 404)

  const body = RunDefaultsBodySchema.safeParse(await safeJson(c.req.raw))
  if (!body.success) {
    return c.json({ error: "invalid input", details: body.error.flatten() }, 400)
  }
  const parsed = parseRunDefaults(def, body.data.runDefaults)
  if (!parsed.ok) {
    return c.json({ error: "invalid input", details: parsed.details }, 400)
  }

  const saved = await updateRunDefaults(tenant.id, id, parsed.value)
  log.info("integration run defaults updated", {
    tenant: tenant.id,
    integration: id,
    runDefaults: saved,
  })
  return c.json(
    scheduleEntry(tenant.id, id, def.name, await getScheduleSettings(tenant.id, id), saved),
  )
})

export default app

function scheduleEntry(
  tenantId: string,
  id: string,
  name: string,
  settings: ScheduleSettings,
  runDefaults: Record<string, unknown>,
) {
  return {
    id,
    name,
    ...settings,
    runDefaults,
    active: isCronActive(tenantId, id),
    nextRun: getNextRun(tenantId, id),
    nextRuns: previewNextRuns(settings.cron, settings.timezone, 5),
  }
}

function validateCron(expr: string, tz: string): { ok: true } | { ok: false; message: string } {
  try {
    const c = new Cron(expr, { timezone: tz, paused: true })
    const next = c.nextRun()
    c.stop()
    if (!next) return { ok: false, message: "cron expression has no future runs" }
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid cron expression"
    return { ok: false, message: msg }
  }
}

function previewNextRuns(expr: string | undefined, tz: string, n: number): string[] {
  if (!expr) return []
  try {
    const c = new Cron(expr, { timezone: tz, paused: true })
    const runs: string[] = []
    let cursor: Date | undefined
    for (let i = 0; i < n; i++) {
      const next = c.nextRun(cursor)
      if (!next) break
      runs.push(next.toISOString())
      cursor = next
    }
    c.stop()
    return runs
  } catch {
    return []
  }
}
