import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"

const searchForProjectsMock = vi.fn()
vi.mock("@miragon/client-clockin", () => ({
  sdk: { searchForProjects: searchForProjectsMock },
}))

const { loadClockinProjectsByNumber, PROJECT_LOOKUP_CHUNK_SIZE } =
  await import("./project-lookup.js")

const noop = () => {
  /* swallow */
}
const warnings: string[] = []
const silentLog: Logger = {
  debug: noop,
  info: noop,
  warn: (message) => void warnings.push(message),
  error: noop,
  child: () => silentLog,
}

const stubClient = {} as never

/** Parameter jedes abgesetzten Suchaufrufs. */
function requestedParameters(): string[][] {
  return searchForProjectsMock.mock.calls.map((call) => call[0].body.scopes[0].parameters)
}

/** Antwort einer ODER-fähigen Suche: eine Zeile je angefragter Nummer. */
function orCapableSearch() {
  searchForProjectsMock.mockImplementation(async (req: unknown) => {
    const parameters = (req as { body: { scopes: { parameters: string[] }[] } }).body.scopes[0]
      .parameters
    return { data: parameters.map((number, i) => ({ id: 1000 + i, name: number, number })) }
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  warnings.length = 0
})

describe("loadClockinProjectsByNumber", () => {
  it("chunks the numbers and asks for the employees relation", async () => {
    orCapableSearch()
    const ids = Array.from({ length: 60 }, (_, i) => `proj-${i}`)

    const lookup = await loadClockinProjectsByNumber(stubClient, ids, { log: silentLog })

    expect(searchForProjectsMock).toHaveBeenCalledTimes(3)
    for (const parameters of requestedParameters()) {
      expect(parameters.length).toBeLessThanOrEqual(PROJECT_LOOKUP_CHUNK_SIZE)
    }
    expect(searchForProjectsMock.mock.calls[0][0].body.includes).toEqual([
      { relation: "employees" },
    ])
    expect(lookup.bundled).toBe(true)
    expect(lookup.size).toBe(60)
    // Schlüssel ist die DIMACON-Nummer, nicht die Clockin-Id
    expect(lookup.get("proj-7").map((r) => r.number)).toEqual(["proj-7"])
  })

  it("adds the customFields relation only when custom targets are mapped", async () => {
    orCapableSearch()

    await loadClockinProjectsByNumber(stubClient, ["a", "b"], { withCustomFields: true })

    expect(searchForProjectsMock.mock.calls[0][0].body.includes).toEqual([
      { relation: "employees" },
      { relation: "customFields" },
    ])
  })

  it("omits the employees relation when the assignment step is off", async () => {
    orCapableSearch()

    await loadClockinProjectsByNumber(stubClient, ["a", "b"], { withEmployees: false })

    expect(searchForProjectsMock.mock.calls[0][0].body.includes).toBeUndefined()
  })

  it("falls back to one request per number when byNumber ignores extra parameters", async () => {
    // Die Probe liefert nur einen Treffer für 25 Nummern ⇒ Bündelung nicht
    // belegt. Der Lauf schaltet um und bleibt trotzdem vollständig.
    const known = new Map(
      Array.from({ length: 30 }, (_, i) => [`proj-${i}`, { id: 500 + i, number: `proj-${i}` }]),
    )
    searchForProjectsMock.mockImplementation(async (req: unknown) => {
      const parameters = (req as { body: { scopes: { parameters: string[] }[] } }).body.scopes[0]
        .parameters
      // Verhalten ohne ODER: nur der erste Parameter wird ausgewertet
      const row = known.get(parameters[0])
      return { data: row ? [row] : [] }
    })

    const lookup = await loadClockinProjectsByNumber(stubClient, [...known.keys()], {
      log: silentLog,
    })

    expect(lookup.bundled).toBe(false)
    expect(lookup.size).toBe(30)
    expect(lookup.get("proj-29").map((r) => r.id)).toEqual([529])
    expect(requestedParameters().every((p) => p.length <= 25)).toBe(true)
    // 1 Probe-Chunk + 30 Einzelanfragen
    expect(searchForProjectsMock).toHaveBeenCalledTimes(31)
    expect(warnings).toContain(
      "clockin byNumber does not appear to accept multiple parameters — per-id lookups",
    )
  })

  it("stays bundled when the probe finds nothing at all (first run)", async () => {
    // Kein Treffer widerlegt die Bündelung NICHT — typisch beim Erstlauf, wenn
    // fast alle Projekte in Clockin noch gar nicht existieren. Fiele der Lauf
    // hier auf Einzelsuchen zurück, träfe es genau den Lauf mit den meisten
    // Projekten.
    const ids = Array.from({ length: 30 }, (_, i) => `proj-${i}`)
    searchForProjectsMock.mockImplementation(async (req: unknown) => {
      const parameters = (req as { body: { scopes: { parameters: string[] }[] } }).body.scopes[0]
        .parameters
      // Probe-Chunk (die ersten 25) ist komplett neu, der Rest existiert schon
      if (parameters.includes("proj-0")) return { data: [] }
      return { data: parameters.map((number, i) => ({ id: 700 + i, number })) }
    })

    const lookup = await loadClockinProjectsByNumber(stubClient, ids, { log: silentLog })

    expect(lookup.bundled).toBe(true)
    // 1 Probe-Chunk + 1 Folge-Chunk, NICHT 30 Einzelanfragen
    expect(searchForProjectsMock).toHaveBeenCalledTimes(2)
    expect(requestedParameters().map((p) => p.length)).toEqual([25, 5])
    expect(lookup.get("proj-25").map((r) => r.id)).toEqual([700])
    expect(warnings).toEqual([])
  })

  it("keeps ALL candidates per number instead of the first", async () => {
    // Mehrwertig: sonst würde eine doppelt vergebene Projektnummer still auf
    // den ersten Treffer kollabieren.
    searchForProjectsMock.mockResolvedValue({
      data: [
        { id: 1, number: "proj-a" },
        { id: 2, number: "proj-a" },
        { id: 3, number: "proj-b" },
      ],
    })

    const lookup = await loadClockinProjectsByNumber(stubClient, ["proj-a", "proj-b"])

    expect(lookup.get("proj-a").map((r) => r.id)).toEqual([1, 2])
    expect(lookup.get("proj-b").map((r) => r.id)).toEqual([3])
  })

  it("drops rows without an id and rows for numbers nobody asked for", async () => {
    searchForProjectsMock.mockResolvedValue({
      data: [
        { number: "proj-a" },
        { id: 2, number: "proj-a" },
        { id: 3, number: "fremd" },
        { id: 4, number: null },
        { id: 5, number: "proj-b" },
      ],
    })

    const lookup = await loadClockinProjectsByNumber(stubClient, ["proj-a", "proj-b", "proj-c"])

    expect(lookup.get("proj-a").map((r) => r.id)).toEqual([2])
    expect(lookup.get("proj-b").map((r) => r.id)).toEqual([5])
    expect(lookup.get("proj-c")).toEqual([])
    expect(lookup.size).toBe(2)
  })

  it("accepts the response as-is for a single requested number (wildcard semantics)", async () => {
    // Der byNumber-Scope erlaubt Wildcards: bei genau einer angefragten
    // Nummer bleibt es beim bisherigen Verhalten der Einzelsuche.
    searchForProjectsMock.mockResolvedValue({ data: [{ id: 9, number: "PROJ-1 " }] })

    const lookup = await loadClockinProjectsByNumber(stubClient, ["proj-1"])

    expect(lookup.get("proj-1").map((r) => r.id)).toEqual([9])
  })

  it("re-checks every miss per number when no chunk proves the bundling", async () => {
    // Der teure Fall (#1): `byNumber` wertet real nur den ERSTEN Parameter aus
    // UND das erste Element JEDES Chunks ist neu. Die Probe sieht 0 Zeilen und
    // widerlegt damit nichts — ohne Gegenprobe bliebe der Index löchrig und
    // der Upserter legte für jedes übersehene Bestandsprojekt ein Duplikat an.
    const ids = Array.from({ length: 30 }, (_, i) => `proj-${i}`)
    const known = new Set(ids.filter((id) => id !== "proj-0" && id !== "proj-25"))
    searchForProjectsMock.mockImplementation(async (req: unknown) => {
      const parameters = (req as { body: { scopes: { parameters: string[] }[] } }).body.scopes[0]
        .parameters
      // Verhalten ohne ODER: nur der erste Parameter wird ausgewertet
      const first = parameters[0]
      return { data: known.has(first) ? [{ id: 900, number: first }] : [] }
    })

    const lookup = await loadClockinProjectsByNumber(stubClient, ids, { log: silentLog })

    // proj-1 existiert in Clockin — die Sammelabfragen haben es übersehen, die
    // Gegenprobe holt es nach. Das ist die eigentliche Zusicherung.
    expect(lookup.get("proj-1").map((r) => r.id)).toEqual([900])
    expect(lookup.get("proj-0")).toEqual([])
    expect(lookup.bundled).toBe(false)
    // 2 Sammel-Chunks + 30 Gegenproben
    expect(searchForProjectsMock).toHaveBeenCalledTimes(32)
    expect(warnings).toContain(
      "clockin byNumber bundling unverified — per-id lookups for the misses",
    )
  })

  it("asks exactly once for a single unknown number", async () => {
    // Eine Anfrage mit EINEM Parameter ist die Einzelsuche — ihre Fehlanzeige
    // braucht keine Gegenprobe.
    searchForProjectsMock.mockResolvedValue({ data: [] })

    const lookup = await loadClockinProjectsByNumber(stubClient, ["proj-1"], { log: silentLog })

    expect(searchForProjectsMock).toHaveBeenCalledTimes(1)
    expect(lookup.bundled).toBe(true)
    expect(warnings).toEqual([])
  })

  it("makes no request at all without ids", async () => {
    const lookup = await loadClockinProjectsByNumber(stubClient, [])

    expect(searchForProjectsMock).not.toHaveBeenCalled()
    expect(lookup.size).toBe(0)
  })
})
