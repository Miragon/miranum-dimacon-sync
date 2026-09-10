import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { tenants } from "../db/schema.js"
import { setWebhookSecret } from "../db/repos/webhook-secrets.js"
import { createTestDb } from "../db/test-db.js"
import type { AccessTokenCheck } from "../lib/auth.js"

const verifyMock = vi.fn<(token: string) => Promise<AccessTokenCheck>>()

// Eigene Datei (statt app.test.ts), damit dort die Haltung „kein jose-Mock
// nötig" erhalten bleibt.
vi.mock("../lib/auth.js", () => ({
  verifyAccessToken: verifyMock,
  isAuthConfigured: () => true,
  AUTH_UNAVAILABLE_MESSAGE:
    "Anmeldedienst nicht erreichbar — bitte in einer Minute erneut versuchen",
}))

const { integrationsOpenRoutes } = await import("./integrations.js")
const { invalidateTenantCache } = await import("../lib/tenant.js")

const SECRET = "webhook-secret-of-org-active"
const RUN_PATH = "/api/integrations/dimacon-clockin/run"

let db: Db
let close: () => Promise<void>
let app: Hono

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  const rows = await db
    .insert(tenants)
    .values([
      { workosOrgId: "org_active", displayName: "Aktiv GmbH" },
      { workosOrgId: "org_inactive", displayName: "Inaktiv GmbH", active: false },
    ])
    .returning()
  await setWebhookSecret(rows.find((r) => r.workosOrgId === "org_active")!.id, SECRET)

  app = new Hono()
  app.route("/api/integrations", integrationsOpenRoutes)
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

beforeEach(() => {
  verifyMock.mockReset()
  invalidateTenantCache()
})

function run(headers: Record<string, string>) {
  return app.request(RUN_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify({ dryRun: true }),
  })
}

/**
 * Dual-Auth des Run-Endpoints. Kern: ein GÜLTIGES JWT mit unbekannter oder
 * inaktiver Org ist fachlich ein 403 (TenantGate-Zustand im Client), kein
 * 401 — ein Re-Login würde daran nichts ändern.
 */
describe("handleIntegrationRun auth", () => {
  it("answers 403 UNKNOWN_ORG for a valid JWT of an unknown organization", async () => {
    verifyMock.mockResolvedValue({ status: "valid", claims: { sub: "u1", org_id: "org_nope" } })

    const res = await run({ authorization: "Bearer jwt" })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "UNKNOWN_ORG" })
  })

  it("answers 403 NO_ORG for a valid JWT without org_id", async () => {
    verifyMock.mockResolvedValue({ status: "valid", claims: { sub: "u1" } })

    const res = await run({ authorization: "Bearer jwt" })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "NO_ORG" })
  })

  it("answers 403 ORG_INACTIVE for a deactivated tenant", async () => {
    verifyMock.mockResolvedValue({ status: "valid", claims: { sub: "u1", org_id: "org_inactive" } })

    const res = await run({ authorization: "Bearer jwt" })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "ORG_INACTIVE" })
  })

  it("stays fail-closed with 401 for an invalid token", async () => {
    verifyMock.mockResolvedValue({ status: "invalid", code: "TOKEN_INVALID" })

    const res = await run({ authorization: "Bearer jwt" })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "unauthorized" })
  })

  it("answers 503 AUTH_UNAVAILABLE when the auth backend is down", async () => {
    verifyMock.mockResolvedValue({ status: "unavailable" })

    const res = await run({ authorization: "Bearer jwt" })
    expect(res.status).toBe(503)
    // Abgegrenzt vom 503 „integration not configured".
    expect(await res.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" })
  })

  it("lets a valid JWT of a known active org through to the credentials check", async () => {
    verifyMock.mockResolvedValue({ status: "valid", claims: { sub: "u1", org_id: "org_active" } })

    const res = await run({ authorization: "Bearer jwt" })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      error: "integration not configured",
      missing: ["dimacon", "clockin"],
    })
  })

  it("keeps 401 for a wrong x-sync-token even with a valid bearer JWT", async () => {
    verifyMock.mockResolvedValue({ status: "valid", claims: { sub: "u1", org_id: "org_active" } })

    const res = await run({ "x-sync-token": "wrong", authorization: "Bearer jwt" })
    expect(res.status).toBe(401)
    expect(verifyMock).not.toHaveBeenCalled()
  })

  it("accepts the tenant webhook secret without touching the JWT path", async () => {
    const res = await run({ "x-sync-token": SECRET })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "integration not configured" })
    expect(verifyMock).not.toHaveBeenCalled()
  })
})
