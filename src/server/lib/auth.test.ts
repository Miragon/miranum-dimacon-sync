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
    expect(await res.json()).toEqual({ error: "missing bearer token" })
  })

  it("rejects a malformed authorization header with 401", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Basic abc" },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "missing bearer token" })
  })

  it("rejects an invalid or expired token with 401", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
    jwtVerifyMock.mockRejectedValue(new Error('"exp" claim timestamp check failed'))

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Bearer not-a-real-token" },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "invalid token" })
  })

  it("rejects a token from the wrong organization with 403", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
    vi.stubEnv("WORKOS_REQUIRED_ORG_ID", "org_expected")
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_1", org_id: "org_other" } })

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Bearer token" },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "forbidden: wrong organization" })
  })

  it("accepts a matching org and pins issuer + RS256", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
    vi.stubEnv("WORKOS_REQUIRED_ORG_ID", "org_expected")
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_1", org_id: "org_expected" } })

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Bearer token" },
    })
    expect(res.status).toBe(200)
    expect(jwtVerifyMock).toHaveBeenCalledWith("token", "jwks-stub", {
      algorithms: ["RS256"],
      issuer: "https://api.workos.com/user_management/client_test",
    })
  })

  it("accepts any org when WORKOS_REQUIRED_ORG_ID is unset", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
    vi.stubEnv("WORKOS_REQUIRED_ORG_ID", "")
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_1", org_id: "org_whatever" } })

    const res = await appWithAuth().request("/x", {
      headers: { authorization: "Bearer token" },
    })
    expect(res.status).toBe(200)
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
