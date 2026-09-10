import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp } from "./app.js"
import { setDbForTests, type Db } from "./db/client.js"
import { tenants } from "./db/schema.js"
import { setWebhookSecret } from "./db/repos/webhook-secrets.js"
import { createTestDb } from "./db/test-db.js"
import { invalidateTenantCache } from "./lib/tenant.js"

/**
 * Pinnt die load-bearing Mount-Reihenfolge aus app.ts: run/healthz sind
 * offen (Mandanten-Webhook-Secret statt JWT), alles andere hängt hinter
 * requireAuth + resolveTenant. Kein jose-Mock nötig — geschützte Routen
 * bekommen nie ein wohlgeformtes Bearer-Token, daher wird nie ein JWKS
 * geladen (ein malformer Token scheitert schon am Decode).
 */

let db: Db
let close: () => Promise<void>
let tenantId: string

const SECRET = "s3cret-webhook-token"

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  const [tenant] = await db
    .insert(tenants)
    .values({ workosOrgId: "org_test", displayName: "Test-Mandant" })
    .returning()
  tenantId = tenant.id
  await setWebhookSecret(tenantId, SECRET)
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

beforeEach(() => {
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
  invalidateTenantCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("mount order (Reihenfolge ist load-bearing)", () => {
  it("keeps healthz endpoints reachable without a token (liveness only)", async () => {
    const app = createApp()
    expect((await app.request("/healthz")).status).toBe(200)

    const sync = await app.request("/api/sync/healthz")
    expect(sync.status).toBe(200)
    // Ohne Secret nur Liveness — configured/nextRun/running sind Mandanten-Daten.
    expect(await sync.json()).toEqual({ ok: true })

    const integ = await app.request("/api/integrations/dimacon-clockin/healthz")
    expect(integ.status).toBe(200)
    expect(await integ.json()).toEqual({ ok: true, integration: "dimacon-clockin" })
  })

  it("returns the full tenant-scoped healthz body with a valid webhook secret", async () => {
    const app = createApp()
    const res = await app.request("/api/integrations/dimacon-clockin/healthz", {
      headers: { "x-sync-token": SECRET },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      integration: "dimacon-clockin",
      configured: false,
      running: false,
      cronActive: false,
    })
  })

  it("protects the API surface behind requireAuth", async () => {
    const app = createApp()
    for (const path of [
      "/api/integrations",
      "/api/mappings/dimacon-clockin",
      "/api/settings/integrations",
      "/api/systems",
      "/api/credentials",
      "/api/me",
      "/api/tenants",
    ]) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
      expect(await res.json()).toMatchObject({
        error: "missing bearer token",
        code: "TOKEN_MISSING",
      })
    }
  })

  it("limits /api/tenants to the dev tenant when auth is disabled", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "")
    const app = createApp()
    const res = await app.request("/api/tenants")
    // Ohne user-Claim (Dev-Bypass) fällt die Route auf den aktiven Mandanten
    // zurück — beweist zugleich, dass tenantsRoute HINTER resolveTenant sitzt
    // (sonst wäre c.get("tenant") undefined und der Request ein 500).
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ orgId: "org_dev", name: "Entwicklung (lokal)" }])
  })

  it("keeps the run webhooks outside the JWT middleware", async () => {
    const app = createApp()
    // Gültiges Mandanten-Secret → der Request läuft bis zum Credentials-Check
    // durch: 503 "integration not configured" beweist, dass kein 401 vom
    // JWT-Layer kam.
    const res = await app.request("/api/sync/run", {
      method: "POST",
      headers: { "x-sync-token": SECRET },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "integration not configured" })
  })
})

describe("webhook tenant auth (fail-closed)", () => {
  it("rejects run calls without a token with 401", async () => {
    const app = createApp()
    const res = await app.request("/api/sync/run", { method: "POST" })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })

  it("rejects a wrong x-sync-token with 401", async () => {
    const app = createApp()
    const res = await app.request("/api/sync/run", {
      method: "POST",
      headers: { "x-sync-token": "nope" },
    })
    expect(res.status).toBe(401)
  })

  it("rejects a Bearer token that is neither a secret nor a valid JWT with 401", async () => {
    const app = createApp()
    const res = await app.request("/api/integrations/dimacon-clockin/run", {
      method: "POST",
      headers: { authorization: "Bearer not-a-jwt" },
    })
    expect(res.status).toBe(401)
  })

  it("accepts the tenant webhook secret and proceeds to the credentials check", async () => {
    const app = createApp()
    const res = await app.request("/api/integrations/dimacon-clockin/run", {
      method: "POST",
      headers: { "x-sync-token": SECRET },
      body: JSON.stringify({ dryRun: true }),
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      error: "integration not configured",
      missing: ["dimacon", "clockin"],
    })
  })

  it("stays fail-closed in production: no token is 401, not the old 503", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const app = createApp()
    const res = await app.request("/api/sync/run", { method: "POST" })
    // Früher: 503 "webhook secret not configured". Jetzt strukturell
    // fail-closed — ohne identifizierbaren Mandanten immer 401.
    expect(res.status).toBe(401)
  })

  it("keeps the dev-open posture when auth is disabled outside production", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "")
    const app = createApp()
    const res = await app.request("/api/sync/run", { method: "POST" })
    // Dev-Tenant wird aufgelöst; ohne Credentials endet der Lauf im 503 —
    // deterministisch, aber eben NICHT 401.
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "integration not configured" })
  })
})
