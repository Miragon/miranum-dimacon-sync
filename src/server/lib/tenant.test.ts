import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../db/repos/tenants.js"

const getTenantByOrgIdMock = vi.fn<(orgId: string) => Promise<Tenant | undefined>>()
const getOrCreateDevTenantMock = vi.fn<() => Promise<Tenant>>()

vi.mock("../db/repos/tenants.js", () => ({
  getTenantByOrgId: getTenantByOrgIdMock,
  getOrCreateDevTenant: getOrCreateDevTenantMock,
}))

const { resolveTenant, invalidateTenantCache } = await import("./tenant.js")
import type { WorkOSClaims } from "./auth.js"

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    workosOrgId: "org_a",
    displayName: "A GmbH",
    active: true,
    managedBy: "manual",
    deactivatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function appWithTenant(claims?: WorkOSClaims) {
  const app = new Hono<{ Variables: { user?: WorkOSClaims; tenant: Tenant } }>()
  app.use("*", async (c, next) => {
    if (claims) c.set("user", claims)
    return next()
  })
  app.use("*", resolveTenant)
  app.get("/x", (c) => c.json({ tenant: c.get("tenant").workosOrgId }))
  return app
}

beforeEach(() => {
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
  getTenantByOrgIdMock.mockReset()
  getOrCreateDevTenantMock.mockReset()
  invalidateTenantCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("resolveTenant", () => {
  it("rejects a token without org_id with 403 NO_ORG", async () => {
    const res = await appWithTenant({ sub: "u1" }).request("/x")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "NO_ORG" })
  })

  it("rejects an unknown org with 403 UNKNOWN_ORG", async () => {
    getTenantByOrgIdMock.mockResolvedValue(undefined)
    const res = await appWithTenant({ sub: "u1", org_id: "org_x" }).request("/x")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "UNKNOWN_ORG" })
  })

  it("rejects a deactivated tenant with 403 ORG_INACTIVE", async () => {
    getTenantByOrgIdMock.mockResolvedValue(tenant({ active: false }))
    const res = await appWithTenant({ sub: "u1", org_id: "org_a" }).request("/x")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "ORG_INACTIVE" })
  })

  it("resolves an active tenant and sets it on the context", async () => {
    getTenantByOrgIdMock.mockResolvedValue(tenant())
    const res = await appWithTenant({ sub: "u1", org_id: "org_a" }).request("/x")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenant: "org_a" })
  })

  it("caches lookups per org until invalidated", async () => {
    getTenantByOrgIdMock.mockResolvedValue(tenant())
    const app = appWithTenant({ sub: "u1", org_id: "org_a" })
    await app.request("/x")
    await app.request("/x")
    expect(getTenantByOrgIdMock).toHaveBeenCalledTimes(1)

    invalidateTenantCache("org_a")
    await app.request("/x")
    expect(getTenantByOrgIdMock).toHaveBeenCalledTimes(2)
  })

  it("does not cache inactive tenants beyond the entry (deactivation bites immediately after invalidate)", async () => {
    getTenantByOrgIdMock.mockResolvedValue(tenant())
    const app = appWithTenant({ sub: "u1", org_id: "org_a" })
    expect((await app.request("/x")).status).toBe(200)

    getTenantByOrgIdMock.mockResolvedValue(tenant({ active: false }))
    invalidateTenantCache("org_a")
    expect((await app.request("/x")).status).toBe(403)
  })

  it("falls back to the dev tenant when auth is disabled", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "")
    getOrCreateDevTenantMock.mockResolvedValue(tenant({ workosOrgId: "org_dev" }))
    const res = await appWithTenant().request("/x")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenant: "org_dev" })
  })
})
