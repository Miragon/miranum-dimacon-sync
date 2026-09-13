import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { updateRunDefaults } from "../db/repos/schedules.js"
import { scheduleSettings, tenantCredentials, tenants } from "../db/schema.js"
import { setWebhookSecret } from "../db/repos/webhook-secrets.js"
import { createTestDb } from "../db/test-db.js"
import type * as AuthModule from "../lib/auth.js"
import type { AccessTokenCheck } from "../lib/auth.js"
import type { IntegrationDefinition, IntegrationRunContext } from "../integrations/types.js"

const verifyMock = vi.fn<(token: string) => Promise<AccessTokenCheck>>()

// Eigene Datei (statt app.test.ts), damit dort die Haltung „kein jose-Mock
// nötig" erhalten bleibt.
// PARTIAL-Mock: nur die JWT-Prüfung wird ersetzt. Ein Voll-Mock würde jeden
// später hinzukommenden Export des Moduls (z. B. `bearerChallenge`) beim
// Zugriff werfen — und die Assertions prüften den im Test nachgebauten Wert
// statt den echten.
vi.mock("../lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  verifyAccessToken: verifyMock,
  isAuthConfigured: () => true,
}))

// Nur `runIntegration` wird ersetzt — der Test nagelt fest, WELCHER Input den
// Lauf erreicht (Registry/getIntegration bleiben echt).
const mocks = vi.hoisted(() => ({
  runIntegration:
    vi.fn<
      (def: IntegrationDefinition, ctx: IntegrationRunContext, input: unknown) => Promise<unknown>
    >(),
}))

import type * as RegistryModule from "../integrations/registry.js"

vi.mock("../integrations/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RegistryModule>()
  return { ...actual, runIntegration: mocks.runIntegration }
})

const { integrationsOpenRoutes } = await import("./integrations.js")
const { invalidateTenantCache } = await import("../lib/tenant.js")

const SECRET = "webhook-secret-of-org-active"
const READY_SECRET = "webhook-secret-of-org-ready"
const INTEGRATION_ID = "dimacon-clockin"
const RUN_PATH = `/api/integrations/${INTEGRATION_ID}/run`

let db: Db
let close: () => Promise<void>
let app: Hono
/** Mandant MIT hinterlegten Zugangsdaten — kommt bis zur Input-Auflösung. */
let readyTenantId: string

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  const rows = await db
    .insert(tenants)
    .values([
      { workosOrgId: "org_active", displayName: "Aktiv GmbH" },
      { workosOrgId: "org_inactive", displayName: "Inaktiv GmbH", active: false },
      { workosOrgId: "org_ready", displayName: "Konfiguriert GmbH" },
    ])
    .returning()
  await setWebhookSecret(rows.find((r) => r.workosOrgId === "org_active")!.id, SECRET)
  readyTenantId = rows.find((r) => r.workosOrgId === "org_ready")!.id
  await setWebhookSecret(readyTenantId, READY_SECRET)
  // Credentials-Zeilen roh: `missingCredentials` liest nur, WELCHE Systeme
  // hinterlegt sind — entschlüsselt wird hier nichts (Lauf ist gemockt).
  await db.insert(tenantCredentials).values([
    { tenantId: readyTenantId, system: "dimacon", secret: "v1:k1:iv:tag:ct", config: {} },
    { tenantId: readyTenantId, system: "clockin", secret: "v1:k1:iv:tag:ct", config: {} },
  ])

  app = new Hono()
  app.route("/api/integrations", integrationsOpenRoutes)
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

beforeEach(async () => {
  verifyMock.mockReset()
  mocks.runIntegration.mockReset()
  mocks.runIntegration.mockResolvedValue({ ok: true })
  invalidateTenantCache()
  await db.delete(scheduleSettings)
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
    expect(res.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"')
    expect(await res.json()).toMatchObject({ error: "unauthorized", code: "TOKEN_INVALID" })
  })

  // Der Befund der JWT-Prüfung erreicht den Aufrufer — dieselbe Unterscheidung
  // liefert requireAuth an jeder anderen /api/*-Route bereits unauthentifiziert.
  it("passes TOKEN_EXPIRED through to the 401 body", async () => {
    verifyMock.mockResolvedValue({ status: "invalid", code: "TOKEN_EXPIRED" })

    const res = await run({ authorization: "Bearer jwt" })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "unauthorized", code: "TOKEN_EXPIRED" })
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

/**
 * Verdrahtung des gespeicherten Umfangs am ausgelösten Lauf (UI, Webhook und
 * Legacy-`/api/sync/run` teilen sich diesen Handler). Ohne diese Tests endet
 * jede Route-Abdeckung an der 503-Credentials-Schranke — ein Refactor könnte
 * den gespeicherten Umfang wieder ignorieren, ohne dass etwas rot wird.
 */
describe("handleIntegrationRun run scope", () => {
  function runAs(body?: unknown) {
    return app.request(RUN_PATH, {
      method: "POST",
      headers: { "x-sync-token": READY_SECRET },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  /** Der Input, mit dem der Lauf tatsächlich gestartet wurde. */
  function startedWith(): unknown {
    expect(mocks.runIntegration).toHaveBeenCalledTimes(1)
    return mocks.runIntegration.mock.calls[0]![2]
  }

  it("uses the stored scope for a webhook call without a body", async () => {
    await updateRunDefaults(readyTenantId, INTEGRATION_ID, {
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

    const res = await runAs()
    expect(res.status).toBe(200)
    expect(startedWith()).toMatchObject({ dryRun: true, steps: { employees: false } })
    expect(mocks.runIntegration.mock.calls[0]![1]).toMatchObject({
      tenantId: readyTenantId,
      trigger: "webhook",
    })
  })

  it("merges the request body over the stored scope one level deep", async () => {
    await updateRunDefaults(readyTenantId, INTEGRATION_ID, {
      dryRun: true,
      steps: {
        employees: true,
        customers: false,
        projects: true,
        assignments: true,
        archive: true,
        employeeCreateInDimacon: false,
      },
    })

    const res = await runAs({ dryRun: false, steps: { employees: false } })
    expect(res.status).toBe(200)
    // customers bleibt aus dem gespeicherten Umfang aus.
    expect(startedWith()).toMatchObject({
      dryRun: false,
      steps: { employees: false, customers: false, projects: true },
    })
  })

  it("falls back to the schema defaults when nothing is stored", async () => {
    const res = await runAs()
    expect(res.status).toBe(200)
    expect(startedWith()).toEqual({})
  })

  it("answers 400 and never runs while the stored scope is invalid", async () => {
    await db.execute(
      sql`insert into schedule_settings (tenant_id, integration_id, run_defaults)
          values (${readyTenantId}, ${INTEGRATION_ID}, '{"steps":{"projects":"yes"}}'::jsonb)`,
    )

    const res = await runAs()
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/gespeicherte Umfang/) })
    expect(mocks.runIntegration).not.toHaveBeenCalled()
  })
})
