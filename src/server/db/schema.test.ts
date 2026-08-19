import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Db } from "./client.js"
import { appMeta, tenantCredentials, tenants } from "./schema.js"
import { createTestDb } from "./test-db.js"

let db: Db
let close: () => Promise<void>

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
})

afterAll(async () => {
  await close()
})

describe("schema via migration 0000 (PGlite)", () => {
  it("inserts a tenant with generated uuid and defaults", async () => {
    const [row] = await db
      .insert(tenants)
      .values({ workosOrgId: "org_test_1", displayName: "Test" })
      .returning()
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.active).toBe(true)
  })

  it("enforces unique workos_org_id", async () => {
    // Drizzle wickelt den PG-Fehler in DrizzleQueryError; der Constraint
    // steckt in error.cause.
    const insert = db.insert(tenants).values({ workosOrgId: "org_test_1", displayName: "Doppelt" })
    await expect(insert).rejects.toSatisfy((err: unknown) =>
      /duplicate key|unique/i.test(String((err as Error).cause ?? err)),
    )
  })

  it("enforces one credentials row per (tenant, system) and cascades on delete", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ workosOrgId: "org_test_2", displayName: "T2" })
      .returning()

    await db.insert(tenantCredentials).values({
      tenantId: tenant.id,
      system: "dimacon",
      secret: "v1:1:aaaa:bbbb:cccc",
      config: { baseUrl: "https://x", tenant: "m" },
    })
    await expect(
      db.insert(tenantCredentials).values({
        tenantId: tenant.id,
        system: "dimacon",
        secret: "v1:1:dddd:eeee:ffff",
      }),
    ).rejects.toSatisfy((err: unknown) =>
      /duplicate key|unique/i.test(String((err as Error).cause ?? err)),
    )

    await db
      .delete(tenants)
      .where(await import("drizzle-orm").then((m) => m.eq(tenants.id, tenant.id)))
    const rest = await db.select().from(tenantCredentials)
    expect(rest.filter((r) => r.tenantId === tenant.id)).toHaveLength(0)
  })

  it("app_meta stores jsonb values by key", async () => {
    await db.insert(appMeta).values({ key: "legacy-seed", value: { seededAt: "2026-08-18" } })
    const rows = await db.select().from(appMeta)
    expect(rows[0].value).toEqual({ seededAt: "2026-08-18" })
  })
})
