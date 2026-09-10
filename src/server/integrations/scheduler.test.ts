import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { updateRunDefaults } from "../db/repos/schedules.js"
import { listRuns } from "../db/repos/sync-runs.js"
import { scheduleSettings, syncRuns, tenantCredentials, tenants } from "../db/schema.js"
import { createTestDb } from "../db/test-db.js"
import { log } from "../lib/log.js"
import { dimaconClockinIntegration } from "./dimacon-clockin/index.js"
import { SyncBusyError } from "./mutex.js"
import type { IntegrationDefinition, IntegrationRunContext } from "./types.js"

// Nur `runIntegration` wird ersetzt (getIntegration/integrations bleiben echt):
// der Test nagelt die VERDRAHTUNG fest — welcher Input beim Lauf ankommt —,
// nicht den Lauf selbst. `vi.hoisted`, weil vi.mock nach oben gezogen wird.
const mocks = vi.hoisted(() => ({
  runIntegration:
    vi.fn<
      (def: IntegrationDefinition, ctx: IntegrationRunContext, input: unknown) => Promise<unknown>
    >(),
}))

import type * as RegistryModule from "./registry.js"

vi.mock("./registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RegistryModule>()
  return { ...actual, runIntegration: mocks.runIntegration }
})

const { runScheduledIntegration } = await import("./scheduler.js")

const CLOCKIN = dimaconClockinIntegration.id

let db: Db
let close: () => Promise<void>
let tenantId: string
let inactiveTenantId: string
let unconfiguredTenantId: string

/** Credentials-Zeilen roh anlegen — `getConfiguredSystems` liest nur `system`. */
async function configure(id: string): Promise<void> {
  await db
    .insert(tenantCredentials)
    .values([
      { tenantId: id, system: "dimacon", secret: "v1:k1:iv:tag:ct", config: {} },
      { tenantId: id, system: "clockin", secret: "v1:k1:iv:tag:ct", config: {} },
    ])
    .onConflictDoNothing()
}

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  const rows = await db
    .insert(tenants)
    .values([
      { workosOrgId: "org_sched", displayName: "Scheduler-Test" },
      { workosOrgId: "org_sched_off", displayName: "Deaktiviert", active: false },
      { workosOrgId: "org_sched_bare", displayName: "Ohne Zugangsdaten" },
    ])
    .returning()
  tenantId = rows.find((r) => r.workosOrgId === "org_sched")!.id
  inactiveTenantId = rows.find((r) => r.workosOrgId === "org_sched_off")!.id
  unconfiguredTenantId = rows.find((r) => r.workosOrgId === "org_sched_bare")!.id
  await configure(tenantId)
  await configure(inactiveTenantId)

  log.info = () => {
    /* swallow */
  }
  log.warn = () => {
    /* swallow */
  }
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

beforeEach(async () => {
  mocks.runIntegration.mockReset()
  mocks.runIntegration.mockResolvedValue({ ok: true })
  await db.delete(scheduleSettings)
  await db.delete(syncRuns)
})

/** Der Input, mit dem der geplante Lauf tatsächlich gestartet wurde. */
function startedWith(): unknown {
  expect(mocks.runIntegration).toHaveBeenCalledTimes(1)
  return mocks.runIntegration.mock.calls[0]![2]
}

/**
 * Verdrahtung des geplanten Laufs: der gespeicherte Umfang muss WIRKLICH bis
 * `runIntegration` durchkommen. Ohne diesen Test bleibt ein Refactor, der die
 * Auflösung wieder durch `inputSchema.parse({})` ersetzt, komplett stumm —
 * und der nächtliche Cron fährt „alles an, live".
 */
describe("runScheduledIntegration", () => {
  it("passes the stored scope through to the run", async () => {
    await updateRunDefaults(tenantId, CLOCKIN, {
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

    await runScheduledIntegration(tenantId, CLOCKIN)

    expect(startedWith()).toMatchObject({ dryRun: true, steps: { employees: false } })
    // Gegenprobe: NICHT die Schema-Defaults (die wären „alles an, live").
    expect(startedWith()).not.toEqual(dimaconClockinIntegration.inputSchema.parse({}))
    // Datum ist flüchtig — ein geplanter Lauf ist immer „heute".
    expect(startedWith()).not.toHaveProperty("date")

    const [def, ctx] = mocks.runIntegration.mock.calls[0]!
    expect(def.id).toBe(CLOCKIN)
    expect(ctx).toMatchObject({ tenantId, trigger: "cron" })
  })

  it("runs with the schema defaults when nothing is stored", async () => {
    await runScheduledIntegration(tenantId, CLOCKIN)
    expect(startedWith()).toEqual(dimaconClockinIntegration.inputSchema.parse({}))
  })

  it("skips the run fail-closed when the stored scope is invalid", async () => {
    await db.execute(
      sql`insert into schedule_settings (tenant_id, integration_id, run_defaults)
          values (${tenantId}, ${CLOCKIN}, '{"steps":{"projects":"yes"}}'::jsonb)`,
    )
    const errors: string[] = []
    const original = log.error
    log.error = (msg) => errors.push(msg)

    try {
      await runScheduledIntegration(tenantId, CLOCKIN)
    } finally {
      log.error = original
    }

    expect(mocks.runIntegration).not.toHaveBeenCalled()
    expect(errors).toContain("scheduled run skipped: invalid stored run defaults")

    // Der Ausfall MUSS in der Historie sichtbar sein — sonst sieht der
    // Mandant nur, dass nichts passiert, ohne Hinweis auf die Ursache.
    const runs = await listRuns(tenantId, CLOCKIN, 5)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: "error", trigger: "cron" })
    expect(runs[0].error).toMatch(/Umfang/)
  })

  it("skips deactivated tenants", async () => {
    await updateRunDefaults(inactiveTenantId, CLOCKIN, { dryRun: false })
    await runScheduledIntegration(inactiveTenantId, CLOCKIN)
    expect(mocks.runIntegration).not.toHaveBeenCalled()
  })

  it("skips tenants without the required credentials", async () => {
    await runScheduledIntegration(unconfiguredTenantId, CLOCKIN)
    expect(mocks.runIntegration).not.toHaveBeenCalled()
  })

  it("swallows a concurrent run instead of killing the cron slot", async () => {
    mocks.runIntegration.mockRejectedValue(new SyncBusyError("busy"))
    await expect(runScheduledIntegration(tenantId, CLOCKIN)).resolves.toBeUndefined()
  })

  it("does nothing for an unknown integration", async () => {
    await runScheduledIntegration(tenantId, "gibt-es-nicht")
    expect(mocks.runIntegration).not.toHaveBeenCalled()
  })
})
