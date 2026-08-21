import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { tenants } from "../db/schema.js"
import { createTestDb } from "../db/test-db.js"
import type { WorkOSClaims } from "../lib/auth.js"
import type { AppEnv, Tenant } from "../lib/tenant.js"

const listUserOrgIdsMock = vi.fn()

vi.mock("../lib/workos.js", () => ({
  listUserOrgIds: listUserOrgIdsMock,
}))

// Dynamisch NACH vi.mock importieren — die Route zieht lib/workos.
const { tenantsRoute } = await import("./me.js")

let db: Db
let close: () => Promise<void>
let tenantA: Tenant
let app: Hono<AppEnv>
let currentUser: WorkOSClaims | undefined

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  const rows = await db
    .insert(tenants)
    .values([
      { workosOrgId: "org_a", displayName: "Alpha GmbH" },
      { workosOrgId: "org_b", displayName: "Beta GmbH" },
      { workosOrgId: "org_c", displayName: "Gamma GmbH" },
      { workosOrgId: "org_d", displayName: "Delta GmbH", active: false },
    ])
    .returning()
  tenantA = rows.find((r) => r.workosOrgId === "org_a")!

  app = new Hono<AppEnv>()
  // Stub-Middleware statt requireAuth/resolveTenant: Tests scopen direkt.
  app.use("*", async (c, next) => {
    c.set("tenant", tenantA)
    if (currentUser) c.set("user", currentUser)
    return next()
  })
  app.route("/api/tenants", tenantsRoute)
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

beforeEach(() => {
  currentUser = { sub: "user_123", org_id: "org_a" }
  listUserOrgIdsMock.mockReset()
})

async function getTenants(): Promise<unknown> {
  const res = await app.request("/api/tenants")
  expect(res.status).toBe(200)
  return res.json()
}

describe("GET /api/tenants", () => {
  it("liefert nur Mandanten, deren Orgs der User angehört (nach Name sortiert)", async () => {
    listUserOrgIdsMock.mockResolvedValue(new Set(["org_a", "org_b"]))

    expect(await getTenants()).toEqual([
      { orgId: "org_a", name: "Alpha GmbH" },
      { orgId: "org_b", name: "Beta GmbH" },
    ])
    expect(listUserOrgIdsMock).toHaveBeenCalledExactlyOnceWith("user_123")
  })

  it("enthält den eigenen Mandanten auch, wenn die Membership-API ihn (noch) nicht listet", async () => {
    listUserOrgIdsMock.mockResolvedValue(new Set(["org_b", "org_c"]))

    expect(await getTenants()).toEqual([
      { orgId: "org_a", name: "Alpha GmbH" },
      { orgId: "org_b", name: "Beta GmbH" },
      { orgId: "org_c", name: "Gamma GmbH" },
    ])
  })

  it("liefert inaktive Mandanten nie — auch bei vorhandener Mitgliedschaft", async () => {
    listUserOrgIdsMock.mockResolvedValue(new Set(["org_a", "org_d"]))

    expect(await getTenants()).toEqual([{ orgId: "org_a", name: "Alpha GmbH" }])
  })

  it("fällt bei fehlgeschlagenem/deaktiviertem Lookup auf den eigenen Mandanten zurück", async () => {
    listUserOrgIdsMock.mockResolvedValue(undefined)

    expect(await getTenants()).toEqual([{ orgId: "org_a", name: "Alpha GmbH" }])
  })

  it("Dev-Modus (kein user-Claim): nur eigener Mandant, kein Membership-Lookup", async () => {
    currentUser = undefined

    expect(await getTenants()).toEqual([{ orgId: "org_a", name: "Alpha GmbH" }])
    expect(listUserOrgIdsMock).not.toHaveBeenCalled()
  })

  it("Single-Org-User bekommt genau einen Eintrag (Client rendert dann keinen Dropdown)", async () => {
    listUserOrgIdsMock.mockResolvedValue(new Set(["org_a"]))

    expect(await getTenants()).toEqual([{ orgId: "org_a", name: "Alpha GmbH" }])
  })
})
