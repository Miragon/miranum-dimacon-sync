import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { tenantCredentials, tenants } from "../db/schema.js"
import { createTestDb } from "../db/test-db.js"
import { _resetCryptoForTests } from "../lib/crypto.js"
import { log } from "../lib/log.js"
import type { AppEnv, Tenant } from "../lib/tenant.js"

const testConnectionMock = vi.fn()

vi.mock("../lib/connection-test.js", () => ({
  testConnection: testConnectionMock,
}))

// Dynamisch NACH vi.mock importieren — die Route zieht connection-test.
const { default: credentials } = await import("./credentials.js")

const ORIGINAL = { ...process.env }
const KEY_1 = randomBytes(32).toString("base64")
const KEY_2 = randomBytes(32).toString("base64")

let db: Db
let close: () => Promise<void>
let tenant: Tenant
let app: Hono<AppEnv>

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  ;[tenant] = await db
    .insert(tenants)
    .values({ workosOrgId: "org_credentials", displayName: "Credentials-Test" })
    .returning()

  log.info = () => {
    /* swallow */
  }
  log.error = () => {
    /* swallow */
  }

  app = new Hono()
  // Stub-Middleware statt requireAuth/resolveTenant: Tests scopen direkt.
  app.use("*", async (c, next) => {
    c.set("tenant", tenant)
    return next()
  })
  app.route("/api/credentials", credentials)
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

beforeEach(async () => {
  process.env.CREDENTIAL_KEYS = `1=${KEY_1}`
  _resetCryptoForTests()
  await db.delete(tenantCredentials)
  testConnectionMock.mockReset()
  testConnectionMock.mockResolvedValue(undefined)
})

afterEach(() => {
  process.env = { ...ORIGINAL }
  _resetCryptoForTests()
})

function testReq(system: string, body: unknown) {
  return app.request(`/api/credentials/${system}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function putReq(system: string, body: unknown) {
  return app.request(`/api/credentials/${system}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/credentials/:system/test", () => {
  it("404 bei unbekanntem System", async () => {
    const res = await testReq("github", {})
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "unknown system" })
    expect(testConnectionMock).not.toHaveBeenCalled()
  })

  it("400 bei ungültigem Body (dimacon ohne baseUrl)", async () => {
    const res = await testReq("dimacon", { token: "tok", tenant: "acme" })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid input")
    expect(testConnectionMock).not.toHaveBeenCalled()
  })

  it("400 token_required ohne Formular-Token und ohne gespeicherte Zeile", async () => {
    const res = await testReq("dimacon", { baseUrl: "https://d.example", tenant: "acme" })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "token_required" })
    expect(testConnectionMock).not.toHaveBeenCalled()
  })

  it("Formular-Token gewinnt und wird getrimmt", async () => {
    const res = await testReq("dimacon", {
      token: "  tok  ",
      baseUrl: "https://d.example",
      tenant: "acme",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(testConnectionMock.mock.calls).toStrictEqual([
      ["dimacon", { apiToken: "tok", baseUrl: "https://d.example", tenant: "acme" }],
    ])
  })

  it("leeres Token: gespeichertes Secret + FORMULAR-Config (Formular gewinnt)", async () => {
    const saved = await putReq("dimacon", {
      token: "stored-tok",
      baseUrl: "https://alt.example",
      tenant: "alt",
    })
    expect(saved.status).toBe(200)

    const res = await testReq("dimacon", {
      token: "",
      baseUrl: "https://neu.example",
      tenant: "neu",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(testConnectionMock.mock.calls).toStrictEqual([
      ["dimacon", { apiToken: "stored-tok", baseUrl: "https://neu.example", tenant: "neu" }],
    ])
  })

  it("clockin: leere Base-URL fällt komplett weg (Client-Default)", async () => {
    const res = await testReq("clockin", { token: "ct", baseUrl: "" })
    expect(res.status).toBe(200)
    expect(testConnectionMock.mock.calls).toStrictEqual([["clockin", { apiToken: "ct" }]])
  })

  it("lexoffice: Secret landet im apiKey-Feld", async () => {
    const res = await testReq("lexoffice", { token: "lex" })
    expect(res.status).toBe(200)
    expect(testConnectionMock.mock.calls).toStrictEqual([["lexoffice", { apiKey: "lex" }]])
  })

  it("sevdesk: Secret landet im apiToken-Feld", async () => {
    const res = await testReq("sevdesk", { token: "sev" })
    expect(res.status).toBe(200)
    expect(testConnectionMock.mock.calls).toStrictEqual([["sevdesk", { apiToken: "sev" }]])
  })

  it("Upstream-Fehler → 200 mit ok:false und formatError-Meldung", async () => {
    testConnectionMock.mockRejectedValue(new Error("HTTP 401 Unauthorized"))
    const res = await testReq("lexoffice", { token: "lex" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, message: "HTTP 401 Unauthorized" })
  })

  it("Upstream-Fehler als Plain-Object wird lesbar formatiert", async () => {
    testConnectionMock.mockRejectedValue({ IssueList: [{ type: "NotAuthorized" }] })
    const res = await testReq("lexoffice", { token: "lex" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, message: "NotAuthorized" })
  })

  it("Decrypt-Fehler → 500, nie als 'nicht konfiguriert' maskiert", async () => {
    const saved = await putReq("dimacon", {
      token: "stored-tok",
      baseUrl: "https://d.example",
      tenant: "acme",
    })
    expect(saved.status).toBe(200)

    // Key-Ring gewechselt: Envelope (keyId 1) ist nicht mehr entschlüsselbar.
    process.env.CREDENTIAL_KEYS = `2=${KEY_2}`
    _resetCryptoForTests()

    const res = await testReq("dimacon", { baseUrl: "https://d.example", tenant: "acme" })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/entschlüsselt/)
    expect(testConnectionMock).not.toHaveBeenCalled()
  })
})
