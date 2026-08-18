import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp } from "./app.js"

/**
 * Pinnt die load-bearing Mount-Reihenfolge aus app.ts: run/healthz sind
 * offen (Webhook-Secret statt JWT), alles andere hängt hinter requireAuth.
 * Kein jose-Mock nötig — die Tests schicken nie ein Bearer-Token an
 * geschützte Routen, daher wird nie ein JWKS geladen.
 */

beforeEach(() => {
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
  vi.stubEnv("WORKOS_REQUIRED_ORG_ID", "org_test")
  vi.stubEnv("SYNC_WEBHOOK_SECRET", "")
  // Dimacon/Clockin-Env leer lassen: run-Aufrufe enden nach dem Auth-Check
  // deterministisch in 503 "integration not configured".
  vi.stubEnv("DIMACON_BASE_URL", "")
  vi.stubEnv("DIMACON_TENANT", "")
  vi.stubEnv("DIMACON_API_TOKEN", "")
  vi.stubEnv("CLOCKIN_API_TOKEN", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("mount order (Reihenfolge ist load-bearing)", () => {
  it("keeps healthz endpoints reachable without a token", async () => {
    const app = createApp()
    expect((await app.request("/healthz")).status).toBe(200)
    expect((await app.request("/api/sync/healthz")).status).toBe(200)
    expect((await app.request("/api/integrations/dimacon-clockin/healthz")).status).toBe(200)
  })

  it("protects the API surface behind requireAuth", async () => {
    const app = createApp()
    for (const path of [
      "/api/integrations",
      "/api/mappings/dimacon-clockin",
      "/api/settings/integrations",
      "/api/systems",
    ]) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
      expect(await res.json()).toEqual({ error: "missing bearer token" })
    }
  })

  it("keeps the run webhooks outside the JWT middleware", async () => {
    const app = createApp()
    // Ohne Secret (Dev) läuft der Request bis zum Env-Check durch —
    // 503 "integration not configured" beweist: kein 401 vom JWT-Layer.
    const res = await app.request("/api/sync/run", { method: "POST" })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "integration not configured" })
  })
})

describe("webhook secret enforcement", () => {
  it("rejects run calls without or with a wrong token when the secret is set", async () => {
    vi.stubEnv("SYNC_WEBHOOK_SECRET", "s3cret")
    const app = createApp()

    const missing = await app.request("/api/sync/run", { method: "POST" })
    expect(missing.status).toBe(401)

    const wrong = await app.request("/api/sync/run", {
      method: "POST",
      headers: { "x-sync-token": "nope" },
    })
    expect(wrong.status).toBe(401)
  })

  it("accepts the correct x-sync-token and proceeds to the env check", async () => {
    vi.stubEnv("SYNC_WEBHOOK_SECRET", "s3cret")
    const app = createApp()

    const res = await app.request("/api/sync/run", {
      method: "POST",
      headers: { "x-sync-token": "s3cret" },
    })
    // Auth-Hürde genommen; ohne Dimacon/Clockin-Env endet der Lauf im 503.
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "integration not configured" })
  })

  it("returns 503 in production when no webhook secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SYNC_WEBHOOK_SECRET", "")
    const app = createApp()

    const res = await app.request("/api/sync/run", { method: "POST" })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "webhook secret not configured" })
  })
})
