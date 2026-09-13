import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"

const searchForProjectsMock = vi.fn()
const updateProjectMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: { searchForProjects: searchForProjectsMock, updateProject: updateProjectMock },
}))

const { archiveHorizonDays, archiveUnplanned, DEFAULT_ARCHIVE_HORIZON_DAYS } =
  await import("./archive.js")

const noop = () => {
  /* swallow */
}
const warnings: { message: string; fields?: unknown }[] = []
const silentLog: Logger = {
  debug: noop,
  info: noop,
  warn: (message, fields) => void warnings.push({ message, fields }),
  error: noop,
  child: () => silentLog,
}

const stubClient = {} as never

function row(id: number, number: string | null = `proj-${id}`) {
  return { id, name: `Projekt ${id}`, number }
}

/** Suchantwort mit Laravel-Meta. */
function page(rows: ReturnType<typeof row>[], currentPage: number, lastPage: number) {
  return { data: rows, meta: { current_page: currentPage, last_page: lastPage, per_page: 2 } }
}

function options(overrides: Partial<Parameters<typeof archiveUnplanned>[1]> = {}) {
  return {
    syncedClockinProjectIds: new Set<number>(),
    horizonProjectNumbers: new Set<string>(),
    horizonComplete: true,
    dryRun: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  warnings.length = 0
  updateProjectMock.mockResolvedValue({})
})

afterEach(() => {
  delete process.env.ARCHIVE_HORIZON_DAYS
})

describe("archiveUnplanned", () => {
  it("reads every page instead of only the first", async () => {
    searchForProjectsMock
      .mockResolvedValueOnce(page([row(1), row(2)], 1, 2))
      .mockResolvedValueOnce(page([row(3)], 2, 2))

    const archived = await archiveUnplanned(stubClient, options(), silentLog)

    expect(searchForProjectsMock).toHaveBeenCalledTimes(2)
    // Seite 1 ohne page-Query, Seite 2 mit
    expect(searchForProjectsMock.mock.calls[0][0].query).toBeUndefined()
    expect(searchForProjectsMock.mock.calls[1][0].query).toEqual({ page: 2 })
    expect(archived.map((a) => a.clockinProjectId)).toEqual([1, 2, 3])
  })

  it("protects ids resolved by this run and numbers planned within the horizon", async () => {
    searchForProjectsMock.mockResolvedValue(page([row(1), row(2), row(3)], 1, 1))

    const archived = await archiveUnplanned(
      stubClient,
      options({
        syncedClockinProjectIds: new Set([1]),
        // Normalisiert (trim/lowercase) — wie der Index-Schlüssel
        horizonProjectNumbers: new Set(["proj-2"]),
      }),
      silentLog,
    )

    expect(archived.map((a) => a.clockinProjectId)).toEqual([3])
    expect(updateProjectMock).toHaveBeenCalledTimes(1)
  })

  it("echoes the project number in the write body", async () => {
    searchForProjectsMock.mockResolvedValue(page([row(7, "P-7")], 1, 1))

    await archiveUnplanned(stubClient, options(), silentLog)

    expect(updateProjectMock.mock.calls[0][0]).toEqual({
      client: stubClient,
      path: { project: 7 },
      body: { name: "Projekt 7", number: "P-7", archived: true },
    })
  })

  it("writes in parallel instead of one after another", async () => {
    searchForProjectsMock.mockResolvedValue(page([row(1), row(2), row(3)], 1, 1))
    let inFlight = 0
    let peak = 0
    updateProjectMock.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 0))
      inFlight--
      return {}
    })

    await archiveUnplanned(stubClient, options(), silentLog)

    expect(peak).toBeGreaterThan(1)
  })

  it("writes nothing in dryRun but reports the candidates", async () => {
    searchForProjectsMock.mockResolvedValue(page([row(1)], 1, 1))

    const archived = await archiveUnplanned(stubClient, options({ dryRun: true }), silentLog)

    expect(updateProjectMock).not.toHaveBeenCalled()
    expect(archived).toEqual([{ clockinProjectId: 1, name: "Projekt 1" }])
  })

  it("archives nothing when the horizon is unknown", async () => {
    // Blast-Radius-Schutz: ohne Horizont wüsste der Lauf nicht, welche
    // Projekte demnächst wieder eingeplant sind.
    const archived = await archiveUnplanned(
      stubClient,
      options({ horizonComplete: false }),
      silentLog,
    )

    expect(archived).toEqual([])
    expect(searchForProjectsMock).not.toHaveBeenCalled()
    expect(updateProjectMock).not.toHaveBeenCalled()
    expect(warnings.map((w) => w.message)).toContain(
      "archive phase skipped — planning horizon unknown",
    )
  })

  it("archives nothing when the pagination is incomplete", async () => {
    // Seite 2 kommt als Seite 1 zurück ⇒ die API ignoriert `page`.
    searchForProjectsMock
      .mockResolvedValueOnce(page([row(1)], 1, 3))
      .mockResolvedValueOnce(page([row(1)], 1, 3))

    const archived = await archiveUnplanned(stubClient, options(), silentLog)

    expect(archived).toEqual([])
    expect(updateProjectMock).not.toHaveBeenCalled()
    expect(warnings.map((w) => w.message)).toContain(
      "archive phase skipped — unarchived project list incomplete",
    )
  })

  it("keeps the already archived projects when a single write fails", async () => {
    // Regression: mit Promise.all verwarf ein einziger Fehlschlag die Liste
    // ALLER bereits archivierten Projekte — der Lauf meldete „0 archiviert",
    // obwohl in Clockin vier Projekte archiviert waren.
    searchForProjectsMock.mockResolvedValue(
      page(
        [1, 2, 3, 4, 5].map((id) => row(id)),
        1,
        1,
      ),
    )
    // Nicht-transienter Fehler (kein 429/5xx) — sonst liefe withRetry ins Backoff.
    updateProjectMock.mockImplementation(async (args: { path: { project: number } }) => {
      if (args.path.project === 3) throw new Error("boom 400")
      return {}
    })
    const errors: [number, string][] = []

    const archived = await archiveUnplanned(
      stubClient,
      options({ onError: (id, message) => void errors.push([id, message]) }),
      silentLog,
    )

    expect(archived.map((a) => a.clockinProjectId)).toEqual([1, 2, 4, 5])
    expect(errors).toEqual([[3, "boom 400"]])
  })

  it("reports the skip reason when the project list is incomplete", async () => {
    // Ohne onSkipped wäre „Schutz hat gegriffen" im Lauf-Ergebnis nicht von
    // „es gab nichts zu archivieren" zu unterscheiden.
    searchForProjectsMock
      .mockResolvedValueOnce(page([row(1)], 1, 3))
      .mockResolvedValueOnce(page([row(1)], 1, 3))
    const skipped: string[] = []

    const archived = await archiveUnplanned(
      stubClient,
      options({ onSkipped: (reason) => void skipped.push(reason) }),
      silentLog,
    )

    expect(archived).toEqual([])
    expect(updateProjectMock).not.toHaveBeenCalled()
    expect(skipped).toHaveLength(1)
    // Der Ladegrund muss durchgereicht werden, nicht nur ein pauschaler Satz.
    expect(skipped[0]).toContain("Clockin-Projektliste unvollständig geladen")
    expect(skipped[0]).toContain("Seite 2 kam als Seite 1 zurück")
  })

  it("never archives projects without a dimacon number", async () => {
    // Zeilen ohne Nummer sind in Clockin von Hand angelegt und stammen nicht
    // aus diesem Sync — sonst wären sie dauerhaft Archiv-Kandidaten.
    searchForProjectsMock.mockResolvedValue(page([row(1, null), row(2, ""), row(3, "P-3")], 1, 1))

    const archived = await archiveUnplanned(stubClient, options(), silentLog)

    expect(archived.map((a) => a.clockinProjectId)).toEqual([3])
    expect(updateProjectMock).toHaveBeenCalledTimes(1)
    expect(updateProjectMock.mock.calls[0][0].path).toEqual({ project: 3 })
  })
})

describe("archiveHorizonDays", () => {
  it("uses the conservative default", () => {
    expect(archiveHorizonDays()).toBe(DEFAULT_ARCHIVE_HORIZON_DAYS)
    expect(DEFAULT_ARCHIVE_HORIZON_DAYS).toBe(14)
  })

  it("follows the env override and ignores nonsense", () => {
    process.env.ARCHIVE_HORIZON_DAYS = "30"
    expect(archiveHorizonDays()).toBe(30)
    process.env.ARCHIVE_HORIZON_DAYS = "-1"
    expect(archiveHorizonDays()).toBe(DEFAULT_ARCHIVE_HORIZON_DAYS)
    process.env.ARCHIVE_HORIZON_DAYS = "viel"
    expect(archiveHorizonDays()).toBe(DEFAULT_ARCHIVE_HORIZON_DAYS)
  })
})
