import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _resetCryptoForTests, credentialAad, decryptSecret } from "../lib/crypto.js"
import type { Db } from "./client.js"
import { setDbForTests } from "./client.js"
import { seedLegacyTenant } from "./seed-legacy.js"
import { hashWebhookSecret } from "./repos/webhook-secrets.js"
import { createTestDb } from "./test-db.js"
import { syncRuns, tenants } from "./schema.js"

const ORIGINAL = { ...process.env }

let db: Db
let close: () => Promise<void>
let dir: string

beforeEach(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  dir = await mkdtemp(join(tmpdir(), "seed-test-"))
  process.env.CREDENTIAL_KEYS = `1=${randomBytes(32).toString("base64")}`
  process.env.WORKOS_REQUIRED_ORG_ID = "org_legacy"
  process.env.DIMACON_API_TOKEN = "dim-token"
  process.env.DIMACON_BASE_URL = "https://dimacon.example.com"
  process.env.DIMACON_TENANT = "miragon"
  process.env.CLOCKIN_API_TOKEN = "clock-token"
  delete process.env.LEXWARE_OFFICE_API_KEY
  delete process.env.SYNC_CRON
  delete process.env.SYNC_TZ
  process.env.SYNC_WEBHOOK_SECRET = "hook-secret"
  process.env.SETTINGS_PATH = join(dir, "settings.json")
  _resetCryptoForTests()
})

afterEach(async () => {
  setDbForTests(undefined)
  await close()
  await rm(dir, { recursive: true, force: true })
  process.env = { ...ORIGINAL }
  _resetCryptoForTests()
})

describe("seedLegacyTenant", () => {
  it("imports tenant, complete systems, settings file and webhook secret", async () => {
    await writeFile(
      process.env.SETTINGS_PATH!,
      JSON.stringify({
        integrations: {
          "dimacon-clockin": { enabled: true, cron: "0 6 * * *", timezone: "Europe/Berlin" },
        },
        fieldMappings: {
          "dimacon-clockin": { project: { version: 1, rules: [] } },
        },
      }),
    )

    const report = await seedLegacyTenant(db)

    expect(report.seeded).toBe(true)
    expect(report.systems).toEqual(["dimacon", "clockin"]) // lexoffice-Env fehlt → übersprungen
    expect(report.schedules).toBe(1)
    expect(report.mappings).toBe(1)
    expect(report.webhookSecret).toBe(true)

    const tenantRows = await db.select().from(tenants)
    expect(tenantRows).toHaveLength(1)
    expect(tenantRows[0].workosOrgId).toBe("org_legacy")

    // Secret ist entschlüsselbar und AAD-gebunden
    const creds = await db.execute(
      sql`SELECT secret FROM tenant_credentials WHERE system = 'dimacon'`,
    )
    const secret = (creds.rows[0] as { secret: string }).secret
    const plain = JSON.parse(decryptSecret(secret, credentialAad(tenantRows[0].id, "dimacon")))
    expect(plain).toEqual({ apiToken: "dim-token" })

    const hooks = await db.execute(sql`SELECT secret_hash FROM tenant_webhook_secrets`)
    expect((hooks.rows[0] as { secret_hash: string }).secret_hash).toBe(
      hashWebhookSecret("hook-secret"),
    )
  })

  it("is a no-op on the second run (marker)", async () => {
    const first = await seedLegacyTenant(db)
    expect(first.seeded).toBe(true)
    const second = await seedLegacyTenant(db)
    expect(second).toMatchObject({ seeded: false, reason: "already_seeded" })
    expect(await db.select().from(tenants)).toHaveLength(1)
  })

  it("skips when tenants already exist (created via script)", async () => {
    await db.insert(tenants).values({ workosOrgId: "org_manual", displayName: "Manuell" })
    const report = await seedLegacyTenant(db)
    expect(report).toMatchObject({ seeded: false, reason: "tenants_exist" })
  })

  it("skips without WORKOS_REQUIRED_ORG_ID", async () => {
    delete process.env.WORKOS_REQUIRED_ORG_ID
    const report = await seedLegacyTenant(db)
    expect(report).toMatchObject({ seeded: false, reason: "no_org_id" })
    expect(await db.select().from(tenants)).toHaveLength(0)
  })

  it("honors SYNC_CRON when no settings file exists (legacy first-boot seeding)", async () => {
    process.env.SYNC_CRON = "15 5 * * *"
    process.env.SYNC_TZ = "Europe/Vienna"
    const report = await seedLegacyTenant(db)
    expect(report.schedules).toBe(1)
    const rows = await db.execute(sql`SELECT cron, timezone, enabled FROM schedule_settings`)
    expect(rows.rows[0]).toMatchObject({
      cron: "15 5 * * *",
      timezone: "Europe/Vienna",
      enabled: true,
    })
  })

  it("parses the oldest legacy settings shape ({ sync: ... })", async () => {
    await writeFile(
      process.env.SETTINGS_PATH!,
      JSON.stringify({ sync: { enabled: true, cron: "0 4 * * *", timezone: "Europe/Berlin" } }),
    )
    const report = await seedLegacyTenant(db)
    expect(report.schedules).toBe(1)
    const rows = await db.execute(sql`SELECT integration_id FROM schedule_settings`)
    expect((rows.rows[0] as { integration_id: string }).integration_id).toBe("dimacon-clockin")
  })

  it("folds the removed dimacon-clockin-employees key", async () => {
    await writeFile(
      process.env.SETTINGS_PATH!,
      JSON.stringify({
        integrations: {
          "dimacon-clockin-employees": {
            enabled: true,
            cron: "0 3 * * *",
            timezone: "Europe/Berlin",
          },
        },
        fieldMappings: {
          "dimacon-clockin-employees": { employee: { version: 1, rules: [] } },
        },
      }),
    )
    const report = await seedLegacyTenant(db)
    // Schedule des entfernten Slots entfällt, Mapping wandert zu dimacon-clockin
    expect(report.schedules).toBe(0)
    expect(report.mappings).toBe(1)
    const rows = await db.execute(sql`SELECT integration_id, entity FROM field_mappings`)
    expect(rows.rows[0]).toMatchObject({ integration_id: "dimacon-clockin", entity: "employee" })
  })
})

describe("sync_runs retention (repo)", () => {
  it("keeps only the newest 50 per (tenant, integration) and does not touch other tenants", async () => {
    const { recordRun } = await import("./repos/sync-runs.js")
    const [t1] = await db
      .insert(tenants)
      .values({ workosOrgId: "org_a", displayName: "A" })
      .returning()
    const [t2] = await db
      .insert(tenants)
      .values({ workosOrgId: "org_b", displayName: "B" })
      .returning()

    const base = Date.parse("2026-01-01T00:00:00Z")
    for (let i = 0; i < 55; i++) {
      await recordRun({
        tenantId: t1.id,
        integrationId: "dimacon-clockin",
        trigger: "cron",
        status: "success",
        dryRun: false,
        input: {},
        result: { i },
        startedAt: new Date(base + i * 60_000),
        finishedAt: new Date(base + i * 60_000 + 1000),
      })
    }
    await recordRun({
      tenantId: t2.id,
      integrationId: "dimacon-clockin",
      trigger: "manual",
      status: "success",
      dryRun: true,
      input: {},
      startedAt: new Date(base),
      finishedAt: new Date(base + 500),
    })

    const all = await db.select().from(syncRuns)
    expect(all.filter((r) => r.tenantId === t1.id)).toHaveLength(50)
    // Fremder Mandant bleibt unangetastet — Retention ist tenant-gescopt
    expect(all.filter((r) => r.tenantId === t2.id)).toHaveLength(1)
  })

  it("lists runs newest first, tenant-scoped and limited", async () => {
    const { listRuns, recordRun } = await import("./repos/sync-runs.js")
    const [t1] = await db
      .insert(tenants)
      .values({ workosOrgId: "org_list_a", displayName: "A" })
      .returning()
    const [t2] = await db
      .insert(tenants)
      .values({ workosOrgId: "org_list_b", displayName: "B" })
      .returning()

    const base = Date.parse("2026-02-01T00:00:00Z")
    for (let i = 0; i < 5; i++) {
      await recordRun({
        tenantId: t1.id,
        integrationId: "dimacon-clockin",
        trigger: "cron",
        status: "success",
        dryRun: i === 0,
        input: { dryRun: i === 0, steps: { employees: false } },
        result: { i },
        startedAt: new Date(base + i * 60_000),
        finishedAt: new Date(base + i * 60_000 + 1000),
      })
    }
    await recordRun({
      tenantId: t2.id,
      integrationId: "dimacon-clockin",
      trigger: "manual",
      status: "error",
      dryRun: false,
      input: {},
      error: "boom",
      startedAt: new Date(base + 10 * 60_000),
      finishedAt: new Date(base + 10 * 60_000 + 10),
    })

    const rows = await listRuns(t1.id, "dimacon-clockin", 3)
    expect(rows).toHaveLength(3)
    // Neueste zuerst
    expect(rows[0].startedAt.getTime()).toBe(base + 4 * 60_000)
    expect(rows[1].startedAt.getTime()).toBe(base + 3 * 60_000)
    // Fremder Mandant taucht nie auf (tenant-gescopt)
    expect(rows.every((r) => r.error === null)).toBe(true)
    // `input` kommt als jsonb-Objekt zurück
    expect(rows[0].input).toEqual({ dryRun: false, steps: { employees: false } })
    expect(rows[0].durationMs).toBe(1000)

    // Andere Integration desselben Mandanten ist leer
    expect(await listRuns(t1.id, "dimacon-lexoffice")).toEqual([])
  })
})
