import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const jwtVerifyMock = vi.fn()
const createRemoteJWKSetMock = vi.fn((_url: URL, _opts?: unknown) => "jwks-stub")

vi.mock("jose", () => ({
  createRemoteJWKSet: createRemoteJWKSetMock,
  jwtVerify: jwtVerifyMock,
}))

const { requireAuth, resetJwksCache, isAuthConfigured } = await import("./auth.js")

function appWithAuth() {
  const app = new Hono()
  app.use("*", requireAuth)
  app.get("/x", (c) => c.json({ ok: true }))
  return app
}

beforeEach(() => {
  jwtVerifyMock.mockReset()
  createRemoteJWKSetMock.mockClear()
  resetJwksCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("requireAuth", () => {
  it("passes through unauthenticated when WORKOS_CLIENT_ID is unset", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "")
    expect(isAuthConfigured()).toBe(false)

    const res = await appWithAuth().request("/x")
    expect(res.status).toBe(200)
    expect(jwtVerifyMock).not.toHaveBeenCalled()
  })

  it("rejects a missing bearer token with 401", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")

    const res = await appWithAuth().request("/x")
    expect(res.status).toBe(401)
    // RFC 9110: auch dieses 401 trägt eine Challenge — ohne vorgelegte
    // Anmeldeinformation aber ohne error-Parameter (RFC 6750 §3.1).
    expect(res.headers.get("www-authenticate")).toBe("Bearer")
    expect(await res.json()).toEqual({ error: "missing bearer token", code: "TOKEN_MISSING" })
  })

  it("rejects a malformed authorization header with 401", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Basic abc" },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe("Bearer")
    expect(await res.json()).toEqual({ error: "missing bearer token", code: "TOKEN_MISSING" })
  })

  it("rejects an expired token with 401 + code and a WWW-Authenticate challenge", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
    jwtVerifyMock.mockRejectedValue(
      Object.assign(new Error('"exp" claim timestamp check failed'), { code: "ERR_JWT_EXPIRED" }),
    )

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Bearer not-a-real-token" },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"')
    expect(await res.json()).toEqual({ error: "invalid token", code: "TOKEN_EXPIRED" })
  })

  it("keeps a structurally broken token at 401 (not in the 503 bucket)", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
    jwtVerifyMock.mockRejectedValue(
      Object.assign(new Error("Invalid Compact JWS"), { code: "ERR_JWS_INVALID" }),
    )

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Bearer garbage" },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "invalid token", code: "TOKEN_INVALID" })
  })

  // Transiente Fehler dürfen NIE als „Token ungültig" durchgehen — sonst
  // wirft ein JWKS-Ausfall jeden Nutzer in einen sinnlosen Re-Login.
  it.each([
    ["ERR_JWKS_TIMEOUT", Object.assign(new Error("timeout"), { code: "ERR_JWKS_TIMEOUT" })],
    [
      "ERR_JWKS_NO_MATCHING_KEY",
      Object.assign(new Error("no key"), { code: "ERR_JWKS_NO_MATCHING_KEY" }),
    ],
    ["a raw fetch TypeError", new TypeError("fetch failed")],
  ])("answers 503 AUTH_UNAVAILABLE for %s", async (_label, err) => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
    jwtVerifyMock.mockRejectedValue(err)

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Bearer token" },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" })
  })

  // Der Org-Vergleich (früher WORKOS_REQUIRED_ORG_ID → 403) lebt jetzt in
  // lib/tenant.ts (resolveTenant) — Tests dazu in tenant.test.ts.

  it("accepts a valid token and pins issuer + RS256", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_1", org_id: "org_whatever" } })

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Bearer token" },
    })
    expect(res.status).toBe(200)
    expect(jwtVerifyMock).toHaveBeenCalledWith("token", "jwks-stub", {
      algorithms: ["RS256"],
      issuer: "https://api.workos.com/user_management/client_test",
      // Uhr-Drift nach Standby darf keinen serverseitigen ERR_JWT_EXPIRED erzeugen.
      clockTolerance: 30,
    })
  })

  it("exposes verifyAccessToken as a valid/invalid/unavailable union", async () => {
    const { verifyAccessToken } = await import("./auth.js")
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")

    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_1", org_id: "org_x" } })
    expect(await verifyAccessToken("good")).toMatchObject({
      status: "valid",
      claims: { sub: "user_1", org_id: "org_x" },
    })

    jwtVerifyMock.mockRejectedValue(
      Object.assign(new Error("expired"), { code: "ERR_JWT_EXPIRED" }),
    )
    expect(await verifyAccessToken("bad")).toEqual({ status: "invalid", code: "TOKEN_EXPIRED" })

    jwtVerifyMock.mockRejectedValue(new TypeError("fetch failed"))
    expect(await verifyAccessToken("bad")).toEqual({ status: "unavailable" })
  })

  it("keys the JWKS cache by client id", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_a")
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "u" } })
    await appWithAuth().request("/x", { headers: { authorization: "Bearer t" } })

    vi.stubEnv("WORKOS_CLIENT_ID", "client_b")
    await appWithAuth().request("/x", { headers: { authorization: "Bearer t" } })

    const urls = createRemoteJWKSetMock.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual([
      "https://api.workos.com/sso/jwks/client_a",
      "https://api.workos.com/sso/jwks/client_b",
    ])
  })
})
