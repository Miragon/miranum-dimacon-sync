import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"
import type { LoadedAppointments } from "../shared/dimacon.js"
import type { EnrichedDimaconData } from "./enrichment.js"

// --- Clockin-SDK ---
const searchForProjectsMock = vi.fn()
const createProjectMock = vi.fn()
const updateProjectMock = vi.fn()
const attachEmployeesMock = vi.fn()
const detachEmployeesMock = vi.fn()
const getAListOfProjectEmployeesMock = vi.fn()
const searchForCustomersMock = vi.fn()
const createCustomerMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: {
    searchForProjects: searchForProjectsMock,
    createProject: createProjectMock,
    updateProject: updateProjectMock,
    attachEmployees: attachEmployeesMock,
    detachEmployees: detachEmployeesMock,
    getAListOfProjectEmployees: getAListOfProjectEmployeesMock,
    searchForCustomers: searchForCustomersMock,
    createCustomer: createCustomerMock,
  },
}))

// --- Module rund um den Orchestrator ---
const clockinClientStub = { kind: "clockin" }
const dimaconClientStub = { kind: "dimacon" }

vi.mock("../../lib/clients.js", () => ({
  getClockInClient: () => clockinClientStub,
  getDimaconClient: () => dimaconClientStub,
  getLexofficeClient: () => ({ kind: "lexoffice" }),
}))

const loadAppointmentsMock = vi.fn()
vi.mock("../shared/dimacon.js", () => ({ loadAppointments: loadAppointmentsMock }))

const enrichMock = vi.fn()
vi.mock("./enrichment.js", () => ({ enrich: enrichMock }))

const loadMappingContextMock = vi.fn()
vi.mock("../shared/mapping-context.js", () => ({ loadMappingContext: loadMappingContextMock }))

const archiveUnplannedMock = vi.fn()
vi.mock("./archive.js", () => ({ archiveUnplanned: archiveUnplannedMock }))

const { runDimaconClockinSync } = await import("./run.js")
const { log } = await import("../../lib/log.js")

const noop = () => {
  /* swallow */
}
const silentLog: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => silentLog,
}
// run.ts baut sich seinen Logger selbst per rootLog.child(...) — hier stummschalten
;(log as { child: Logger["child"] }).child = () => silentLog

const DATE = "2026-08-01"
const CLOCKIN_PROJECT_ID = 55

function loadedAppointments(): LoadedAppointments {
  const appointment = {
    id: "appt-1",
    jobId: "job-1",
    teamId: "team-1",
    date: `${DATE}T07:00:00`,
    isArchived: false,
  }
  return {
    appointments: [appointment],
    jobIds: ["job-1"],
    byJobId: new Map([["job-1", [appointment]]]),
    counts: { total: 1, live: 1 },
  }
}

function enrichedData(): EnrichedDimaconData {
  return {
    jobs: new Map([
      ["job-1", { jobId: "job-1", projectId: "proj-1", customerId: "cust-1", teamAssignments: [] }],
    ]),
    projects: new Map([
      [
        "proj-1",
        { id: "proj-1", name: "Baustelle A", street: "Musterweg 1", zipCity: "80331 München" },
      ],
    ]),
    customers: new Map([
      ["cust-1", { id: "cust-1", customerNumber: "D-100", name: "Muster GmbH" }],
    ]),
    employees: new Map(),
  }
}

function archivedSet(): Set<number> {
  return archiveUnplannedMock.mock.calls[0][1] as Set<number>
}

beforeEach(() => {
  vi.resetAllMocks()

  loadAppointmentsMock.mockResolvedValue(loadedAppointments())
  enrichMock.mockResolvedValue(enrichedData())
  // Leerer Kontext → run.ts fällt auf die Default-Zuordnung zurück
  loadMappingContextMock.mockResolvedValue(new Map())
  archiveUnplannedMock.mockResolvedValue([])

  searchForProjectsMock.mockResolvedValue({
    data: [
      {
        id: CLOCKIN_PROJECT_ID,
        name: "Baustelle A",
        number: "proj-1",
        start_date: `${DATE}T07:30:00`,
        archived: false,
      },
    ],
  })
  getAListOfProjectEmployeesMock.mockResolvedValue({ data: [] })
  searchForCustomersMock.mockResolvedValue({
    data: [{ id: 7, company: "Muster GmbH", identifier: "D-100" }],
  })
  createCustomerMock.mockResolvedValue({ data: { id: 42 } })
  createProjectMock.mockResolvedValue({ data: { id: 99 } })
  updateProjectMock.mockResolvedValue({})
  attachEmployeesMock.mockResolvedValue({})
  detachEmployeesMock.mockResolvedValue({})
})

describe("runDimaconClockinSync (Orchestrierung)", () => {
  it("keeps archive protection intact when the mapping context fails to load (safe mode)", async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    loadMappingContextMock.mockRejectedValue(new Error("boom 400"))

    const result = await runDimaconClockinSync({ date: DATE })

    // Safe-Mode: Schreibschritte deaktiviert, Fehler dokumentiert
    expect(result.steps.projects).toBe(false)
    expect(result.steps.customers).toBe(false)
    expect(result.errors.some((e) => e.scope === "mapping")).toBe(true)
    expect(createProjectMock).not.toHaveBeenCalled()
    expect(updateProjectMock).not.toHaveBeenCalled()
    expect(createCustomerMock).not.toHaveBeenCalled()

    // Archiv-Phase läuft trotzdem — mit der per searchForProjects
    // aufgelösten Clockin-ID als geschütztem Projekt
    expect(archiveUnplannedMock).toHaveBeenCalledTimes(1)
    expect(archiveUnplannedMock.mock.calls[0][0]).toBe(clockinClientStub)
    expect([...archivedSet()]).toEqual([CLOCKIN_PROJECT_ID])
  })

  it("still protects the resolved project id when the customer sync fails", async () => {
    searchForCustomersMock.mockRejectedValue(new Error("boom 400"))

    const result = await runDimaconClockinSync({ date: DATE })

    expect(result.errors).toContainEqual(
      expect.objectContaining({ scope: "customer", refId: "cust-1" }),
    )
    // Der Upsert löst die Clockin-ID trotz Kunden-Fehler auf ...
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].clockinProjectId).toBe(CLOCKIN_PROJECT_ID)
    // ... und die Archiv-Phase bekommt sie als geschützt gemeldet
    expect(archiveUnplannedMock).toHaveBeenCalledTimes(1)
    expect(archivedSet().has(CLOCKIN_PROJECT_ID)).toBe(true)
  })

  it("skips the archive phase entirely when steps.archive is disabled", async () => {
    const result = await runDimaconClockinSync({
      date: DATE,
      steps: { customers: true, employees: true, projects: true, archive: false },
    })

    expect(result.errors).toEqual([])
    expect(result.steps.archive).toBe(false)
    expect(archiveUnplannedMock).not.toHaveBeenCalled()
    expect(result.archived).toEqual([])
  })
})
