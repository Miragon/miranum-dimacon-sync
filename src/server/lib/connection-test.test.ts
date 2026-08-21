import { beforeEach, describe, expect, it, vi } from "vitest"

const createDimaconClientMock = vi.fn()
const getCurrentUserMock = vi.fn()
const createClockInClientMock = vi.fn()
const getAListOfProjectsMock = vi.fn()
const createLexofficeClientMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  createDimaconClient: createDimaconClientMock,
  sdk: { getCurrentUser: getCurrentUserMock },
}))
vi.mock("@miragon/client-clockin", () => ({
  createClockInClient: createClockInClientMock,
  sdk: { getAListOfProjects: getAListOfProjectsMock },
}))
vi.mock("@miragon/client-lexoffice", () => ({
  createLexofficeClient: createLexofficeClientMock,
}))

const { mapUpstreamError, testConnection } = await import("./connection-test.js")

// hey-api-Clients brauchen die Interceptor-Registrierung als Mock-Oberfläche.
function heyApiClient() {
  return { interceptors: { error: { use: vi.fn() } } }
}

let dimaconClient: ReturnType<typeof heyApiClient>
let clockinClient: ReturnType<typeof heyApiClient>
let lexofficeGet: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetAllMocks()
  dimaconClient = heyApiClient()
  clockinClient = heyApiClient()
  lexofficeGet = vi.fn().mockResolvedValue({ organizationId: "org" })
  createDimaconClientMock.mockReturnValue(dimaconClient)
  createClockInClientMock.mockReturnValue(clockinClient)
  createLexofficeClientMock.mockReturnValue({ get: lexofficeGet })
  getCurrentUserMock.mockResolvedValue({})
  getAListOfProjectsMock.mockResolvedValue({})
})

describe("testConnection", () => {
  it("dimacon: baut Wegwerf-Client, registriert Interceptor, ruft getCurrentUser mit Signal", async () => {
    await testConnection("dimacon", {
      apiToken: "tok",
      baseUrl: "https://dimacon.example",
      tenant: "acme",
    })

    expect(createDimaconClientMock).toHaveBeenCalledExactlyOnceWith({
      apiToken: "tok",
      baseUrl: "https://dimacon.example",
      tenant: "acme",
    })
    expect(dimaconClient.interceptors.error.use).toHaveBeenCalledExactlyOnceWith(mapUpstreamError)
    expect(getCurrentUserMock).toHaveBeenCalledTimes(1)
    const options = getCurrentUserMock.mock.calls[0]![0] as { client: unknown; signal: unknown }
    expect(options.client).toBe(dimaconClient)
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it("clockin: optionale Base-URL darf fehlen (Client-Default greift)", async () => {
    await testConnection("clockin", { apiToken: "ct" })

    expect(createClockInClientMock.mock.calls[0]).toStrictEqual([{ apiToken: "ct" }])
    expect(clockinClient.interceptors.error.use).toHaveBeenCalledExactlyOnceWith(mapUpstreamError)
    expect(getAListOfProjectsMock).toHaveBeenCalledTimes(1)
  })

  it("lexoffice: prüft /v1/profile mit dem Wegwerf-Client", async () => {
    await testConnection("lexoffice", { apiKey: "lex" })

    expect(createLexofficeClientMock).toHaveBeenCalledExactlyOnceWith({ apiKey: "lex" })
    expect(lexofficeGet).toHaveBeenCalledExactlyOnceWith("/v1/profile")
  })

  it("validiert die Payload, bevor ein Client gebaut wird", async () => {
    await expect(testConnection("dimacon", { apiToken: "tok" })).rejects.toThrow()
    expect(createDimaconClientMock).not.toHaveBeenCalled()
    expect(getCurrentUserMock).not.toHaveBeenCalled()
  })

  it("übersetzt einen Abort/Timeout in eine deutsche Meldung", async () => {
    getCurrentUserMock.mockRejectedValue(new DOMException("aborted", "TimeoutError"))
    await expect(
      testConnection("dimacon", {
        apiToken: "tok",
        baseUrl: "https://dimacon.example",
        tenant: "acme",
      }),
    ).rejects.toThrow(/Zeitüberschreitung/)
  })

  it("reicht Upstream-Fehler des Lexoffice-Clients unverändert durch", async () => {
    lexofficeGet.mockRejectedValue(new Error("Lexoffice API 401: Unauthorized"))
    await expect(testConnection("lexoffice", { apiKey: "lex" })).rejects.toThrow(
      "Lexoffice API 401: Unauthorized",
    )
  })
})

describe("mapUpstreamError", () => {
  it("lässt Netzwerkfehler (ohne Response) unangetastet", () => {
    const err = new TypeError("fetch failed")
    expect(mapUpstreamError(err, undefined)).toBe(err)
  })

  it("macht aus dem leeren hey-api-Fehler-Body den HTTP-Status", () => {
    const mapped = mapUpstreamError(
      {},
      new Response(null, { status: 401, statusText: "Unauthorized" }),
    )
    expect(mapped).toBeInstanceOf(Error)
    expect((mapped as Error).message).toBe("HTTP 401 Unauthorized")
  })

  it("hängt vorhandene Fehlerdetails an den Status an", () => {
    const mapped = mapUpstreamError({ message: "Bad token" }, new Response(null, { status: 403 }))
    expect((mapped as Error).message).toBe("HTTP 403 — Bad token")
  })
})
