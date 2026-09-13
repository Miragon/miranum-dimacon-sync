import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { scheduleSettings, tenants } from "../db/schema.js"
import { createTestDb } from "../db/test-db.js"
import { log } from "../lib/log.js"
import type { AppEnv, Tenant } from "../lib/tenant.js"
import { stopScheduler } from "../integrations/scheduler.js"
import settings from "./settings.js"

const CLOCKIN = "dimacon-clockin"

interface ScheduleEntryJson {
  id: string
  name: string
  enabled: boolean
  cron?: string
  timezone: string
  runDefaults: Record<string, unknown>
  active: boolean
  nextRun: string | null
  nextRuns: string[]
}

let db: Db
let close: () => Promise<void>
let tenant: Tenant
let app: Hono<AppEnv>

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  ;[tenant] = await db
    .insert(tenants)
    .values({ workosOrgId: "org_settings", displayName: "Settings-Test" })
    .returning()

  log.info = () => {
    /* swallow */
  }

  app = new Hono()
  // Stub-Middleware statt requireAuth/resolveTenant: Tests scopen direkt.
  app.use("*", async (c, next) => {
    c.set("tenant", tenant)
    return next()
  })
  app.route("/api/settings", settings)
})

afterAll(async () => {
  // Der Zeitplan-PUT startet echte Cron-Slots — sonst hängt der Prozess.
  stopScheduler()
  setDbForTests(undefined)
  await close()
})

beforeEach(async () => {
  stopScheduler()
  await db.delete(scheduleSettings)
})

function putRunDefaults(body: unknown, id = CLOCKIN) {
  return app.request(`/api/settings/integrations/${id}/run-defaults`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function putSchedule(body: unknown, id = CLOCKIN) {
  return app.request(`/api/settings/integrations/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function storedRunDefaults(id = CLOCKIN): Promise<Record<string, unknown> | undefined> {
  const rows = await db
    .select()
    .from(scheduleSettings)
    .where(and(eq(scheduleSettings.tenantId, tenant.id), eq(scheduleSettings.integrationId, id)))
  return rows[0]?.runDefaults
}

describe("GET /api/settings/integrations", () => {
  it("returns empty run defaults before the first save", async () => {
    const res = await app.request("/api/settings/integrations")
    expect(res.status).toBe(200)
    const entries = (await res.json()) as ScheduleEntryJson[]
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) expect(entry.runDefaults).toEqual({})
  })
})

describe("PUT /api/settings/integrations/:id/run-defaults", () => {
  it("stores the normalized scope and drops the date", async () => {
    const res = await putRunDefaults({
      runDefaults: { date: "2026-05-09", dryRun: true, steps: { employees: false } },
    })
    expect(res.status).toBe(200)
    const entry = (await res.json()) as ScheduleEntryJson
    expect(entry.id).toBe(CLOCKIN)
    // Vollständiger ScheduleEntry — der Client setzt ihn direkt als State.
    expect(entry).toMatchObject({ enabled: false, timezone: "Europe/Berlin", active: false })
    expect(entry.runDefaults).not.toHaveProperty("date")
    expect(entry.runDefaults).toEqual({
      dryRun: true,
      steps: {
        employees: false,
        customers: true,
        projects: true,
        assignments: true,
        archive: true,
        employeeCreateInDimacon: false,
      },
    })
    expect(await storedRunDefaults()).toEqual(entry.runDefaults)
  })

  it("rejects an invalid step value with 400", async () => {
    const res = await putRunDefaults({ runDefaults: { steps: { projects: "yes" } } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "invalid input" })
  })

  it("rejects a body without runDefaults with 400", async () => {
    const res = await putRunDefaults({ dryRun: true })
    expect(res.status).toBe(400)
  })

  it("answers 404 for an unknown integration", async () => {
    const res = await putRunDefaults({ runDefaults: {} }, "does-not-exist")
    expect(res.status).toBe(404)
  })
})

/**
 * LOAD-BEARING: Zeitplan und Umfang teilen sich eine Tabellenzeile, aber
 * zwei Endpoints — keiner darf die Felder des anderen überschreiben.
 */
describe("schedule PUT and run-defaults PUT are independent", () => {
  it("keeps the stored scope when the schedule is saved", async () => {
    await putRunDefaults({ runDefaults: { dryRun: true, steps: { employees: false } } })
    const before = await storedRunDefaults()

    const res = await putSchedule({ enabled: true, cron: "0 6 * * *", timezone: "Europe/Berlin" })
    expect(res.status).toBe(200)
    const entry = (await res.json()) as ScheduleEntryJson
    expect(entry.enabled).toBe(true)
    expect(entry.runDefaults).toEqual(before)
    expect(await storedRunDefaults()).toEqual(before)
  })

  it("keeps the schedule when the scope is saved", async () => {
    await putSchedule({ enabled: true, cron: "0 6 * * *", timezone: "Europe/Vienna" })

    const res = await putRunDefaults({ runDefaults: { dryRun: true } })
    expect(res.status).toBe(200)
    const entry = (await res.json()) as ScheduleEntryJson
    expect(entry).toMatchObject({ enabled: true, cron: "0 6 * * *", timezone: "Europe/Vienna" })

    const rows = await db
      .select()
      .from(scheduleSettings)
      .where(
        and(eq(scheduleSettings.tenantId, tenant.id), eq(scheduleSettings.integrationId, CLOCKIN)),
      )
    expect(rows[0]).toMatchObject({ enabled: true, cron: "0 6 * * *", timezone: "Europe/Vienna" })
  })
})
