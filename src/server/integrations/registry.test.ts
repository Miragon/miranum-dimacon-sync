import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { syncRuns, tenants } from "../db/schema.js"
import { createTestDb } from "../db/test-db.js"
import { countRequest, withPhase } from "../lib/metrics.js"
import { runIntegration } from "./registry.js"
import type { IntegrationDefinition, IntegrationRunContext } from "./types.js"

let db: Db
let close: () => Promise<void>
let tenantId: string

const silentLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silentLog,
}

function ctx(): IntegrationRunContext {
  return {
    tenantId,
    trigger: "manual",
    clients: {} as IntegrationRunContext["clients"],
    getFieldMapping: async () => undefined,
    log: silentLog as unknown as IntegrationRunContext["log"],
  }
}

function definition(run: IntegrationDefinition["run"]): IntegrationDefinition {
  return {
    id: "test-integration",
    name: "Test",
    description: "",
    systems: ["dimacon"],
    requiredCredentials: [],
    inputSchema: { parse: (v: unknown) => v } as unknown as IntegrationDefinition["inputSchema"],
    run,
  }
}

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  const [row] = await db
    .insert(tenants)
    .values({ workosOrgId: "org_registry", displayName: "Registry" })
    .returning()
  tenantId = row!.id
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

describe("runIntegration — Lauf-Metrik", () => {
  it("hängt die gemessenen Phasen ans Ergebnis und persistiert sie", async () => {
    const def = definition(async () => {
      await withPhase("laden", async () => {
        countRequest("dimacon")
        countRequest("dimacon")
      })
      await withPhase("schreiben", async () => {
        countRequest("clockin")
      })
      return { ok: true }
    })

    const result = (await runIntegration(def, ctx(), { dryRun: true })) as {
      ok: boolean
      metrics: { requests: Record<string, number>; phases: { phase: string }[] }
    }

    expect(result.ok).toBe(true)
    expect(result.metrics.requests).toEqual({ dimacon: 2, clockin: 1, lexoffice: 0 })
    expect(result.metrics.phases.map((p) => p.phase)).toEqual(["laden", "schreiben"])

    const [stored] = await db
      .select({ result: syncRuns.result })
      .from(syncRuns)
      .where(eq(syncRuns.integrationId, "test-integration"))
    expect(stored!.result).toMatchObject({ ok: true, metrics: { requests: { dimacon: 2 } } })
  })

  it("lässt Nicht-Objekt-Ergebnisse unangetastet", async () => {
    const def = definition(async () => "fertig")
    expect(await runIntegration({ ...def, id: "test-string" }, ctx(), {})).toBe("fertig")
  })

  it("meldet die Metriken auch, wenn der Lauf scheitert", async () => {
    silentLog.info.mockClear()
    const def = definition(async () => {
      await withPhase("laden", async () => {
        countRequest("clockin")
        throw new Error("kaputt")
      })
    })

    await expect(runIntegration({ ...def, id: "test-error" }, ctx(), {})).rejects.toThrow("kaputt")

    const metricsLog = silentLog.info.mock.calls.find((c) => c[0] === "integration run metrics")
    expect(metricsLog?.[1]).toMatchObject({
      integration: "test-error",
      metrics: { requests: { clockin: 1 } },
    })
  })
})
