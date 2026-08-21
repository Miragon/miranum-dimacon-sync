import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetWorkosCacheForTests,
  listAllOrganizations,
  listOrgFlagSlugs,
  listUserOrgIds,
} from "./workos.js"
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

describe("Org-Sync-Fetcher (fail-loud)", () => {
  it("paginiert die Org-Liste vollständig über den after-Cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "org_a", name: "Alpha" }],
          list_metadata: { before: null, after: "cur_1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "org_b", name: "Beta" }],
          list_metadata: { before: null, after: null },
        }),
      )

    const orgs = await listAllOrganizations()

    expect(orgs).toEqual([
      { id: "org_a", name: "Alpha" },
      { id: "org_b", name: "Beta" },
    ])
    expect(String(fetchMock.mock.calls[1]![0])).toContain("after=cur_1")
  })

  it("wirft ohne WORKOS_API_KEY statt still undefined zu liefern", async () => {
    vi.stubEnv("WORKOS_API_KEY", "")
    await expect(listAllOrganizations()).rejects.toThrow(/WORKOS_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("wirft bei HTTP-Fehlern", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }))
    await expect(listAllOrganizations()).rejects.toThrow(/HTTP 500/)
  })

  it("wirft bei unerwartetem Response-Schema", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: "nope" }))
    await expect(listAllOrganizations()).rejects.toThrow()
  })

  it("wirft beim Page-Cap statt still zu kappen", async () => {
    // Frische Response je Aufruf — ein Body ist nur einmal lesbar.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [{ id: "org_x", name: "X" }],
          list_metadata: { before: null, after: "immer-mehr" },
        }),
      ),
    )
    await expect(listAllOrganizations()).rejects.toThrow(/Seiten/)
  })

  it("listOrgFlagSlugs liefert die Slugs der Org und wirft bei Fehlern", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [{ slug: "dimacon-sync" }, { slug: "anderes-feature" }],
        list_metadata: { before: null, after: null },
      }),
    )
    expect(await listOrgFlagSlugs("org_a")).toEqual(new Set(["dimacon-sync", "anderes-feature"]))
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/organizations/org_a/feature-flags")

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(listOrgFlagSlugs("org_b")).rejects.toThrow(/HTTP 404/)
  })
})
