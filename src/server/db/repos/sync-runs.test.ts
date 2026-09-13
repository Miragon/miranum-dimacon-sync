import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setDbForTests, type Db } from "../client.js"
import { syncRuns, tenants } from "../schema.js"
import { createTestDb } from "../test-db.js"
import { recordRun } from "./sync-runs.js"

let db: Db
let close: () => Promise<void>
let tenantA: string
let tenantB: string

const METRICS = {
  totalMs: 1234,
  requests: { dimacon: 7, clockin: 12, lexoffice: 0 },
  retries: 1,
  rateLimited: 1,
  waitedMs: 3000,
  phases: [{ phase: "projects", durationMs: 900, requests: { dimacon: 0, clockin: 12 } }],
}

function record(tenantId: string, result: unknown, startedAt: Date) {
  return recordRun({
    tenantId,
    integrationId: "dimacon-clockin",
    trigger: "manual",
    status: "success",
    dryRun: false,
    input: { dryRun: false },
    result,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1_000),
  })
}

async function results(tenantId: string): Promise<unknown[]> {
  const rows = await db
    .select({ result: syncRuns.result })
    .from(syncRuns)
    .where(and(eq(syncRuns.tenantId, tenantId), eq(syncRuns.integrationId, "dimacon-clockin")))
  return rows.map((r) => r.result)
}

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  const rows = await db
    .insert(tenants)
    .values([
      { workosOrgId: "org_runs_a", displayName: "A" },
      { workosOrgId: "org_runs_b", displayName: "B" },
    ])
    .returning()
  tenantA = rows[0]!.id
  tenantB = rows[1]!.id
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

describe("recordRun (PGlite)", () => {
  it("persistiert das Ergebnis inklusive metrics", async () => {
    await record(tenantA, { date: "2026-01-02", projects: [], metrics: METRICS }, new Date())
    const [stored] = await results(tenantA)
    expect(stored).toMatchObject({ date: "2026-01-02", metrics: METRICS })
  })

  it("behält die Metriken, wenn ein übergroßes Ergebnis gekürzt wird", async () => {
    const huge = {
      metrics: METRICS,
      projects: Array.from({ length: 20_000 }, (_, i) => ({
        dimaconProjectId: `p-${i}`,
        name: "Ein hinreichend langer Projektname zum Aufblähen des Ergebnisses",
        status: "unchanged",
      })),
    }
    await record(tenantB, huge, new Date())
    const [stored] = await results(tenantB)
    expect(stored).toEqual({ truncated: true, metrics: METRICS })
  })

  it("kürzt ohne Metriken wie bisher auf { truncated: true }", async () => {
    const huge = { blob: "x".repeat(600 * 1024) }
    await record(tenantB, huge, new Date())
    const stored = await results(tenantB)
    expect(stored).toContainEqual({ truncated: true })
  })

  it("hält die Retention tenant-gescopt", async () => {
    const base = Date.now()
    for (let i = 0; i < 55; i++) {
      await record(tenantA, { i }, new Date(base + i * 1_000))
    }
    // Direkt gegen die Tabelle zählen: `listRuns` klemmt selbst auf
    // MAX_LIST_LIMIT=50 und könnte die Retention deshalb nie widerlegen.
    expect((await results(tenantA)).length).toBe(50)
    // Die Läufe des anderen Mandanten bleiben unangetastet.
    expect((await results(tenantB)).length).toBe(2)
  })
})
