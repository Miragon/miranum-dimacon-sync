import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { _resetWorkosCacheForTests, listUserOrgIds } from "./workos.js"
import { log } from "./log.js"

const fetchMock = vi.fn()

beforeAll(() => {
  log.warn = () => {
    /* swallow */
  }
})

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("WORKOS_API_KEY", "sk_test")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  _resetWorkosCacheForTests()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function membershipsPage(orgs: { id: string; status?: string }[], after?: string): Response {
  return jsonResponse({
    data: orgs.map((o) => ({ organization_id: o.id, status: o.status ?? "active" })),
    list_metadata: { before: null, after: after ?? null },
  })
}

describe("listUserOrgIds", () => {
  it("ist ohne WORKOS_API_KEY aus (undefined, kein fetch)", async () => {
    vi.stubEnv("WORKOS_API_KEY", "")
    expect(await listUserOrgIds("user_1")).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("liefert die Org-Ids einer Seite und ruft die API korrekt auf", async () => {
    fetchMock.mockResolvedValue(membershipsPage([{ id: "org_a" }, { id: "org_b" }]))

    const result = await listUserOrgIds("user_1")

    expect(result).toEqual(new Set(["org_a", "org_b"]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(String(url)).toContain("https://api.workos.com/user_management/organization_memberships")
    expect(String(url)).toContain("user_id=user_1")
    expect(String(url)).toContain("statuses=active")
    expect(String(url)).toContain("limit=100")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test")
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("folgt dem after-Cursor und vereinigt die Seiten", async () => {
    fetchMock
      .mockResolvedValueOnce(membershipsPage([{ id: "org_a" }], "om_cursor"))
      .mockResolvedValueOnce(membershipsPage([{ id: "org_b" }]))

    const result = await listUserOrgIds("user_1")

    expect(result).toEqual(new Set(["org_a", "org_b"]))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]![0])).toContain("after=om_cursor")
  })

  it("filtert nicht-aktive Mitgliedschaften defensiv heraus", async () => {
    fetchMock.mockResolvedValue(
      membershipsPage([{ id: "org_a" }, { id: "org_p", status: "pending" }]),
    )
    expect(await listUserOrgIds("user_1")).toEqual(new Set(["org_a"]))
  })

  it("wird bei HTTP-Fehlern zu undefined", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    expect(await listUserOrgIds("user_1")).toBeUndefined()
  })

  it("wird bei unerwartetem Response-Schema zu undefined", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: "nope" }))
    expect(await listUserOrgIds("user_1")).toBeUndefined()
  })

  it("cached Erfolge 60 s je User", async () => {
    fetchMock.mockResolvedValue(membershipsPage([{ id: "org_a" }]))

    await listUserOrgIds("user_1")
    await listUserOrgIds("user_1")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    _resetWorkosCacheForTests()
    await listUserOrgIds("user_1")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("cached Fehlschläge nicht", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(membershipsPage([{ id: "org_a" }]))

    expect(await listUserOrgIds("user_1")).toBeUndefined()
    expect(await listUserOrgIds("user_1")).toEqual(new Set(["org_a"]))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
