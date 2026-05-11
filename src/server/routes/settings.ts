import { Cron } from "croner"
import { Hono } from "hono"
import { getSyncSettings, SyncSettingsSchema, updateSyncSettings } from "../lib/settings.js"
import { log } from "../lib/log.js"
import { getNextRun, isCronActive, startScheduler } from "../sync/scheduler.js"

const app = new Hono()

app.get("/sync", async (c) => {
  const sync = await getSyncSettings()
  return c.json({
    ...sync,
    active: isCronActive(),
    nextRun: getNextRun(),
    nextRuns: previewNextRuns(sync.cron, sync.timezone, 5),
  })
})

app.put("/sync", async (c) => {
  const raw = await safeJson(c.req.raw)
  const parsed = SyncSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: "invalid input", details: parsed.error.flatten() }, 400)
  }
  const input = parsed.data

  if (input.enabled && !input.cron) {
    return c.json({ error: "cron expression required when sync is enabled" }, 400)
  }
  if (input.cron) {
    const v = validateCron(input.cron, input.timezone)
    if (!v.ok) return c.json({ error: v.message }, 400)
  }

  const saved = await updateSyncSettings(input)
  await startScheduler()
  log.info("sync settings updated", {
    enabled: saved.enabled,
    cron: saved.cron ?? null,
    tz: saved.timezone,
  })
  return c.json({
    ...saved,
    active: isCronActive(),
    nextRun: getNextRun(),
    nextRuns: previewNextRuns(saved.cron, saved.timezone, 5),
  })
})

export default app

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
