import { Cron } from "croner"
import { Hono } from "hono"
import {
  getScheduleSettings,
  ScheduleSettingsSchema,
  updateScheduleSettings,
} from "../lib/settings.js"
import { log } from "../lib/log.js"
import { getIntegration, integrations } from "../integrations/registry.js"
import { getNextRun, isCronActive, startIntegrationCron } from "../integrations/scheduler.js"
import type { ScheduleSettings } from "../lib/settings.js"

const app = new Hono()

app.get("/integrations", async (c) => {
  const entries = await Promise.all(
    integrations.map(async (def) =>
      scheduleEntry(def.id, def.name, await getScheduleSettings(def.id)),
    ),
  )
  return c.json(entries)
})

app.put("/integrations/:id", async (c) => {
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

  const saved = await updateScheduleSettings(id, input)
  await startIntegrationCron(id)
  log.info("integration schedule updated", {
    integration: id,
    enabled: saved.enabled,
    cron: saved.cron ?? null,
    tz: saved.timezone,
  })
  return c.json(scheduleEntry(id, def.name, saved))
})

export default app

function scheduleEntry(id: string, name: string, settings: ScheduleSettings) {
  return {
    id,
    name,
    ...settings,
    active: isCronActive(id),
    nextRun: getNextRun(id),
    nextRuns: previewNextRuns(settings.cron, settings.timezone, 5),
  }
}

async function safeJson(req: Request): Promise<unknown> {
  if (req.headers.get("content-length") === "0") return {}
  try {
    return await req.json()
  } catch {
    return {}
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
