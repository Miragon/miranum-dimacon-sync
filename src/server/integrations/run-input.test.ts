import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { updateRunDefaults } from "../db/repos/schedules.js"
import { scheduleSettings, tenants } from "../db/schema.js"
import { createTestDb } from "../db/test-db.js"
import { dimaconClockinIntegration } from "./dimacon-clockin/index.js"
import { dimaconLexofficeIntegration } from "./dimacon-lexoffice/index.js"
import {
  mergeRunInput,
  parseRunDefaults,
  resolveRunInput,
  resolveScheduledInput,
  stripVolatileRunKeys,
} from "./run-input.js"

describe("stripVolatileRunKeys", () => {
  it("removes date and keeps the scope fields", () => {
    expect(
      stripVolatileRunKeys({ date: "2026-05-09", dryRun: true, steps: { employees: false } }),
    ).toEqual({ dryRun: true, steps: { employees: false } })
  })

  it("turns non-objects into an empty object", () => {
    expect(stripVolatileRunKeys("nope")).toEqual({})
    expect(stripVolatileRunKeys(null)).toEqual({})
    expect(stripVolatileRunKeys([1, 2])).toEqual({})
  })
})

describe("mergeRunInput", () => {
  it("lets the override win on the top level", () => {
    expect(mergeRunInput({ dryRun: false, steps: { employees: true } }, { dryRun: true })).toEqual({
      dryRun: true,
      steps: { employees: true },
    })
  })

  it("merges nested steps one level deep", () => {
    const merged = mergeRunInput(
      { steps: { employees: true, customers: false, archive: true } },
      { steps: { employees: false } },
    )
    // customers bleibt false — der Override löscht die übrigen Schritte nicht.
    expect(merged).toEqual({ steps: { employees: false, customers: false, archive: true } })
  })

  it("is the identity for empty defaults", () => {
    const body = { date: "2026-05-09", dryRun: true }
    expect(mergeRunInput({}, body)).toEqual(body)
  })

  it("passes non-object overrides through unchanged", () => {
    expect(mergeRunInput({ dryRun: true }, "kaputt")).toBe("kaputt")
    expect(mergeRunInput({ dryRun: true }, null)).toBeNull()
    expect(mergeRunInput({ dryRun: true }, [1])).toEqual([1])
  })
})

describe("parseRunDefaults", () => {
  it("normalizes and drops the volatile date", () => {
    const parsed = parseRunDefaults(dimaconClockinIntegration, {
      date: "2026-01-01",
      dryRun: true,
      steps: { employees: false },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).not.toHaveProperty("date")
    expect(parsed.value).toEqual({
      dryRun: true,
      steps: {
        employees: false,
        customers: true,
        projects: true,
        assignments: true,
        archive: true,
        // Anlage in Dimacon bleibt aus (Issue #17), auch beim Expandieren.
        employeeCreateInDimacon: false,
      },
    })
  })

  it("rejects invalid step values with details", () => {
    const parsed = parseRunDefaults(dimaconClockinIntegration, { steps: { projects: "yes" } })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.details).toBeTruthy()
  })

  it("keeps an empty object empty (identical to the previous parse({}))", () => {
    expect(parseRunDefaults(dimaconLexofficeIntegration, {})).toEqual({ ok: true, value: {} })
  })
})

describe("resolveScheduledInput / resolveRunInput (PGlite)", () => {
  let db: Db
  let close: () => Promise<void>
  let tenantId: string

  beforeAll(async () => {
    ;({ db, close } = await createTestDb())
    setDbForTests(db)
    const [tenant] = await db
      .insert(tenants)
      .values({ workosOrgId: "org_run_input", displayName: "Run-Input" })
      .returning()
    tenantId = tenant.id
  })

  afterAll(async () => {
    setDbForTests(undefined)
    await close()
  })

  beforeEach(async () => {
    await db.delete(scheduleSettings)
  })

  it("behaves exactly like before when nothing is stored", async () => {
    const resolved = await resolveScheduledInput(dimaconClockinIntegration, tenantId)
    expect(resolved).toEqual({ ok: true, input: {} })
    // Gegenprobe: identisch zum alten inputSchema.parse({})
    expect(resolved.ok && resolved.input).toEqual(dimaconClockinIntegration.inputSchema.parse({}))
  })

  it("uses the stored scope and never carries a date", async () => {
    await updateRunDefaults(tenantId, dimaconClockinIntegration.id, {
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
    const resolved = await resolveScheduledInput(dimaconClockinIntegration, tenantId)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.input).not.toHaveProperty("date")
    expect(resolved.input).toMatchObject({ dryRun: true, steps: { employees: false } })
  })

  it("drops a smuggled-in date from the stored defaults", async () => {
    await db.insert(scheduleSettings).values({
      tenantId,
      integrationId: dimaconClockinIntegration.id,
      runDefaults: { date: "2020-01-01", dryRun: true },
    })
    const resolved = await resolveScheduledInput(dimaconClockinIntegration, tenantId)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.input).toEqual({ dryRun: true })
  })

  it("stays fail-closed for invalid stored defaults", async () => {
    await db.execute(
      sql`insert into schedule_settings (tenant_id, integration_id, run_defaults)
          values (${tenantId}, ${dimaconClockinIntegration.id}, '{"steps":{"projects":"yes"}}'::jsonb)`,
    )
    const resolved = await resolveScheduledInput(dimaconClockinIntegration, tenantId)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.message).toMatch(/gespeicherte Umfang/)
  })

  it("merges the request body over the stored defaults", async () => {
    await updateRunDefaults(tenantId, dimaconClockinIntegration.id, {
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

    const empty = await resolveRunInput(dimaconClockinIntegration, tenantId, {})
    expect(empty.ok && empty.input).toMatchObject({ dryRun: true, steps: { employees: false } })

    const live = await resolveRunInput(dimaconClockinIntegration, tenantId, { dryRun: false })
    expect(live.ok && live.input).toMatchObject({ dryRun: false, steps: { employees: false } })

    const dated = await resolveRunInput(dimaconClockinIntegration, tenantId, {
      date: "2026-05-09",
    })
    expect(dated.ok && dated.input).toMatchObject({
      date: "2026-05-09",
      dryRun: true,
      steps: { employees: false },
    })
  })

  it("returns 'invalid input' details for a broken body", async () => {
    const broken = await resolveRunInput(dimaconClockinIntegration, tenantId, "kaputt")
    expect(broken.ok).toBe(false)
    if (broken.ok) return
    expect(broken.error).toBe("invalid input")
  })

  it("blocks triggered runs while the stored defaults are invalid", async () => {
    await db.execute(
      sql`insert into schedule_settings (tenant_id, integration_id, run_defaults)
          values (${tenantId}, ${dimaconLexofficeIntegration.id}, '{"steps":{"alignNumbers":42}}'::jsonb)`,
    )
    const resolved = await resolveRunInput(dimaconLexofficeIntegration, tenantId, {})
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error).toMatch(/gespeicherte Umfang/)
  })
})
