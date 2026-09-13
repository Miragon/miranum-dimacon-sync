import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"
import type { AppointmentForDate } from "../shared/dimacon.js"

const getAllJobsInPeriodMock = vi.fn()
const getCurrentTeamAssignmentsMock = vi.fn()
const getAllJobAppointmentsInPeriodMock = vi.fn()
const getJobByIdMock = vi.fn()
const getAllProjectsMock = vi.fn()
const getProjectByIdMock = vi.fn()
const allCustomersMock = vi.fn()
const getCustomerByIdMock = vi.fn()
const getAllEmployeesMock = vi.fn()
const getAllUsersMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: {
    getAllJobsInPeriod: getAllJobsInPeriodMock,
    getCurrentTeamAssignments: getCurrentTeamAssignmentsMock,
    getAllJobAppointmentsInPeriod: getAllJobAppointmentsInPeriodMock,
    getJobById: getJobByIdMock,
    getAllProjects: getAllProjectsMock,
    getProjectById: getProjectByIdMock,
    allCustomers: allCustomersMock,
    getCustomerById: getCustomerByIdMock,
    getAllEmployees: getAllEmployeesMock,
    getAllUsers: getAllUsersMock,
  },
}))

const { enrich } = await import("./enrichment.js")

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
const DATE = "2026-08-14"
const HORIZON = { from: "2026-07-31", to: "2026-08-29" }

const jobIds = (n: number) => Array.from({ length: n }, (_, i) => `job-${i}`)

function appointment(i: number, overrides: Partial<AppointmentForDate> = {}): AppointmentForDate {
  return {
    id: `appt-${i}`,
    jobId: `job-${i}`,
    teamId: `team-${i}`,
    date: `${DATE}T07:00:00`,
    isArchived: false,
    ...overrides,
  }
}

function periodJob(i: number) {
  return {
    id: `job-${i}`,
    projectId: `proj-${i}`,
    customerId: `cust-${i}`,
    appointments: [appointment(i)],
  }
}

function project(i: number) {
  return { id: `proj-${i}`, name: `Projekt ${i}`, street: "Weg 1", zipCity: "80331 München" }
}

const preloadedCustomers = Array.from({ length: 12 }, (_, i) => ({
  id: `cust-${i}`,
  name: `Kunde ${i}`,
}))
const preloadedEmployees = [
  {
    id: "e-1",
    firstName: "Anna",
    lastName: "Muster",
    role: "CRAFTSMAN" as const,
    color: "#000",
    timeTrackingActive: true,
    isArchived: false,
    email: "anna@example.com",
  },
]

beforeEach(() => {
  vi.resetAllMocks()
  warnings.length = 0
  getAllJobsInPeriodMock.mockResolvedValue(jobIds(10).map((_, i) => periodJob(i)))
  getCurrentTeamAssignmentsMock.mockResolvedValue([
    { teamId: "team-0", employeeId: "e-1", date: `${DATE}T00:00:00`, isFixed: true },
  ])
  getAllJobAppointmentsInPeriodMock.mockResolvedValue(jobIds(10).map((_, i) => appointment(i)))
  getJobByIdMock.mockImplementation(async (req: { path: { jobId: string } }) => {
    const i = Number(req.path.jobId.split("-")[1])
    return {
      job: { id: `job-${i}`, projectId: `proj-${i}`, customerId: `cust-${i}` },
      teamAssignments:
        i === 0
          ? [{ teamId: "team-0", employeeId: "e-1", date: `${DATE}T00:00:00`, isFixed: true }]
          : [],
    }
  })
  getAllProjectsMock.mockResolvedValue(jobIds(12).map((_, i) => project(i)))
  getProjectByIdMock.mockImplementation(async (req: { path: { projectId: string } }) =>
    project(Number(req.path.projectId.split("-")[1])),
  )
  allCustomersMock.mockResolvedValue(preloadedCustomers)
  getCustomerByIdMock.mockImplementation(async (req: { path: { customerId: string } }) => ({
    id: req.path.customerId,
    name: req.path.customerId,
  }))
  getAllEmployeesMock.mockResolvedValue([{ id: "e-1", firstName: "Anna", lastName: "Muster" }])
  getAllUsersMock.mockResolvedValue([{ employeeId: "e-1", emailAddress: "anna@example.com" }])
})

function bulkOptions(overrides: Record<string, unknown> = {}) {
  return {
    jobIds: jobIds(10),
    appointments: jobIds(10).map((_, i) => appointment(i)),
    date: DATE,
    needsTeamAssignments: true,
    horizon: HORIZON,
    customers: preloadedCustomers,
    employees: preloadedEmployees,
    log: silentLog,
    ...overrides,
  }
}

describe("enrich — Sammelabrufe", () => {
  it("replaces the per-item lookups with one call each", async () => {
    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.sources).toEqual({
      jobs: "period",
      teamAssignments: "period",
      projects: "bulk",
      customers: "preloaded",
    })
    expect(getAllJobsInPeriodMock).toHaveBeenCalledTimes(1)
    expect(getAllJobsInPeriodMock.mock.calls[0][0].query).toEqual(HORIZON)
    expect(getAllProjectsMock).toHaveBeenCalledTimes(1)
    // Nur die eine Probe, kein getJobById je Auftrag
    expect(getJobByIdMock).toHaveBeenCalledTimes(1)
    expect(getProjectByIdMock).not.toHaveBeenCalled()
    // Vorgeladene Kunden und Mitarbeiter ⇒ gar kein Abruf
    expect(getCustomerByIdMock).not.toHaveBeenCalled()
    expect(allCustomersMock).not.toHaveBeenCalled()
    expect(getAllEmployeesMock).not.toHaveBeenCalled()
    expect(getAllUsersMock).not.toHaveBeenCalled()

    expect(enriched.jobs.size).toBe(10)
    expect(enriched.projects.get("proj-3")?.name).toBe("Projekt 3")
    expect(enriched.customers.get("cust-3")?.name).toBe("Kunde 3")
    expect(enriched.employees.get("e-1")?.email).toBe("anna@example.com")
  })

  it("joins team assignments over teamId and date", async () => {
    getCurrentTeamAssignmentsMock.mockResolvedValue([
      { teamId: "team-0", employeeId: "e-1", date: `${DATE}T00:00:00`, isFixed: true },
      { teamId: "team-1", employeeId: "e-2", date: `${DATE}T00:00:00`, isFixed: true },
      // Anderer Tag — darf nicht durchschlagen
      { teamId: "team-1", employeeId: "e-9", date: "2026-08-15T00:00:00", isFixed: true },
    ])

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.jobs.get("job-1")?.teamAssignments.map((a) => a.employeeId)).toEqual(["e-2"])
    expect(enriched.jobs.get("job-2")?.teamAssignments).toEqual([])
  })

  it("falls back to per-job lookups when the probe disagrees", async () => {
    // getJobById kennt für job-0 einen Mitarbeiter, den der Zeitraum-Abruf
    // nicht liefert ⇒ die Annahme ist widerlegt.
    getCurrentTeamAssignmentsMock.mockResolvedValue([])

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.sources.teamAssignments).toBe("per-job")
    expect(warnings).toContain(
      "team assignment join differs from getJobById — falling back to per-job lookups",
    )
    // Probe (1) + die übrigen 9 Aufträge — der Probe-Auftrag wird nicht doppelt geladen
    expect(getJobByIdMock).toHaveBeenCalledTimes(10)
    expect(enriched.jobs.get("job-0")?.teamAssignments.map((a) => a.employeeId)).toEqual(["e-1"])
  })

  it("loads jobs the period call does not know individually", async () => {
    getAllJobsInPeriodMock.mockResolvedValue(jobIds(9).map((_, i) => periodJob(i)))

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.jobs.size).toBe(10)
    expect(enriched.jobs.get("job-9")?.projectId).toBe("proj-9")
    expect(getJobByIdMock.mock.calls.map((c) => c[0].path.jobId)).toContain("job-9")
  })

  it("still works when the period call fails entirely", async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    getAllJobsInPeriodMock.mockRejectedValue(new Error("boom 400"))

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.sources.jobs).toBe("per-job")
    expect(enriched.jobs.size).toBe(10)
    expect(getJobByIdMock).toHaveBeenCalledTimes(10)
  })

  it("skips the team assignment fetch when the step is off", async () => {
    const enriched = await enrich(stubClient, bulkOptions({ needsTeamAssignments: false }))

    expect(enriched.sources.teamAssignments).toBe("none")
    expect(getCurrentTeamAssignmentsMock).not.toHaveBeenCalled()
    expect(getJobByIdMock).not.toHaveBeenCalled()
    expect([...enriched.jobs.values()].every((j) => j.teamAssignments.length === 0)).toBe(true)
  })

  it("uses per-item lookups below the threshold", async () => {
    const enriched = await enrich(stubClient, {
      jobIds: jobIds(3),
      appointments: jobIds(3).map((_, i) => appointment(i)),
      date: DATE,
      needsTeamAssignments: true,
      customers: undefined,
      employees: preloadedEmployees,
      log: silentLog,
    })

    expect(enriched.sources).toEqual({
      jobs: "per-job",
      teamAssignments: "per-job",
      projects: "per-id",
      customers: "per-id",
    })
    expect(getAllJobsInPeriodMock).not.toHaveBeenCalled()
    expect(getAllProjectsMock).not.toHaveBeenCalled()
    expect(getJobByIdMock).toHaveBeenCalledTimes(3)
    expect(getProjectByIdMock).toHaveBeenCalledTimes(3)
    expect(getCustomerByIdMock).toHaveBeenCalledTimes(3)
    // Kein Horizont angefragt ⇒ die Archiv-Phase darf nicht schreiben
    expect(enriched.horizon.complete).toBe(false)
    expect(getAllJobAppointmentsInPeriodMock).not.toHaveBeenCalled()
  })

  // getJobById kennt für job-0 (den ersten Probe-Auftrag) keine Zuordnung —
  // ein legitimer Normalfall, der den Vergleich aussagelos macht.
  const probeJobWithoutAssignment = () =>
    getJobByIdMock.mockImplementation(async (req: { path: { jobId: string } }) => {
      const i = Number(req.path.jobId.split("-")[1])
      return {
        job: { id: `job-${i}`, projectId: `proj-${i}`, customerId: `cust-${i}` },
        teamAssignments:
          i === 1
            ? [{ teamId: "team-1", employeeId: "e-2", date: `${DATE}T00:00:00`, isFixed: true }]
            : [],
      }
    })

  it("falls back to per-job lookups when the join matches no job at all", async () => {
    probeJobWithoutAssignment()
    // Der Join läuft ins Leere (hier: Zeilen ohne teamId). Ohne Guard bestätigt
    // der leere Vergleich am zuordnungslosen job-0 die Bündelung — und der Lauf
    // hängt die Belegschaft JEDES Tagesprojekts ab.
    getCurrentTeamAssignmentsMock.mockResolvedValue([
      { employeeId: "e-2", date: `${DATE}T00:00:00`, isFixed: true },
    ])

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.sources.teamAssignments).toBe("per-job")
    expect(warnings).toContain(
      "team assignment join could not be verified — falling back to per-job lookups",
    )
    expect(enriched.jobs.get("job-1")?.teamAssignments.map((a) => a.employeeId)).toEqual(["e-2"])
    // Probe (1) + die übrigen 9 — der Probe-Auftrag wird nicht doppelt geladen
    expect(getJobByIdMock).toHaveBeenCalledTimes(10)
  })

  it("falls back to per-job lookups when the period dates use another format", async () => {
    probeJobWithoutAssignment()
    // Zweite reale Ursache eines leeren Joins: das Datum passt nicht zum Filter.
    getCurrentTeamAssignmentsMock.mockResolvedValue([
      { teamId: "team-1", employeeId: "e-2", date: "14.08.2026", isFixed: true },
    ])

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.sources.teamAssignments).toBe("per-job")
    expect(enriched.jobs.get("job-1")?.teamAssignments.map((a) => a.employeeId)).toEqual(["e-2"])
  })

  it("probes a second job when the first one has no assignment", async () => {
    probeJobWithoutAssignment()
    getCurrentTeamAssignmentsMock.mockResolvedValue([
      { teamId: "team-1", employeeId: "e-2", date: `${DATE}T00:00:00`, isFixed: true },
    ])

    const enriched = await enrich(stubClient, bulkOptions())

    // OHNE den Fix ist allein die Aufrufliste rot (nur ["job-0"]) — die beiden
    // anderen Erwartungen sind Regressionsschutz gegen einen pauschalen
    // per-job-Fallback bei zuordnungslosem Erst-Auftrag.
    expect(getJobByIdMock.mock.calls.map((c) => c[0].path.jobId)).toEqual(["job-0", "job-1"])
    expect(enriched.sources.teamAssignments).toBe("period")
    expect(enriched.jobs.get("job-1")?.teamAssignments.map((a) => a.employeeId)).toEqual(["e-2"])
    expect(enriched.jobs.get("job-0")?.teamAssignments).toEqual([])
  })

  it("falls back to per-id project lookups when the bulk fetch fails", async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    getAllProjectsMock.mockRejectedValue(new Error("boom 400"))

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.sources.projects).toBe("per-id")
    expect(warnings).toContain("dimacon project bulk fetch failed — falling back to per-id lookups")
    expect(getAllProjectsMock).toHaveBeenCalledTimes(1)
    expect(getProjectByIdMock).toHaveBeenCalledTimes(10)
    expect(enriched.projects.get("proj-3")?.name).toBe("Projekt 3")
    // Der Rest des Laufs bleibt vollständig — sonst fiele die Tagesplanung samt
    // Zuordnungen und Archiv-Schutz komplett aus.
    expect(enriched.jobs.size).toBe(10)
    expect(enriched.horizon.complete).toBe(true)
  })

  it("falls back to per-id customer lookups when the bulk fetch fails", async () => {
    // `customers: undefined` = run.ts konnte den Bestand nicht laden
    // (loadCustomerInventory ist fail-soft); der zweite Versuch scheitert auch.
    allCustomersMock.mockRejectedValue(new Error("boom 400"))

    const enriched = await enrich(stubClient, bulkOptions({ customers: undefined }))

    expect(enriched.sources.customers).toBe("per-id")
    expect(warnings).toContain(
      "dimacon customer bulk fetch failed — falling back to per-id lookups",
    )
    // Genau EIN zweiter Versuch, danach die Einzelabrufe des Tages
    expect(allCustomersMock).toHaveBeenCalledTimes(1)
    expect(getCustomerByIdMock).toHaveBeenCalledTimes(10)
    expect(enriched.customers.get("cust-3")?.name).toBe("cust-3")
    expect(enriched.jobs.size).toBe(10)
  })

  it("still aborts when the per-id fallback fails too", async () => {
    // LOAD-BEARING für die Archiv-Phase: `loadProjectsById` liefert entweder
    // ALLE Projekte oder wirft. Käme eine Teilmenge durch, meldete run.ts die
    // fehlenden als „nicht gefunden", ohne sie in `syncedClockinIds` zu legen —
    // und die Archiv-Phase archivierte ein heute eingeplantes Projekt.
    getAllProjectsMock.mockRejectedValue(new Error("boom 400"))
    getProjectByIdMock.mockRejectedValue(new Error("boom 400"))

    await expect(enrich(stubClient, bulkOptions())).rejects.toThrow()
  })

  it("loads the employees itself when nothing is preloaded", async () => {
    const enriched = await enrich(stubClient, bulkOptions({ employees: undefined }))

    expect(getAllEmployeesMock).toHaveBeenCalledTimes(1)
    expect(getAllUsersMock).toHaveBeenCalledTimes(1)
    expect(enriched.employees.get("e-1")?.email).toBe("anna@example.com")
  })
})

describe("enrich — Archiv-Horizont", () => {
  it("collects the projects planned within the horizon window", async () => {
    getAllJobAppointmentsInPeriodMock.mockResolvedValue([
      appointment(1, { date: "2026-08-20T07:00:00" }),
      appointment(2, { date: "2026-08-02T07:00:00" }),
      // archiviert ⇒ zählt nicht als eingeplant
      appointment(3, { date: "2026-08-21T07:00:00", isArchived: true }),
    ])

    const enriched = await enrich(stubClient, bulkOptions())

    expect(getAllJobAppointmentsInPeriodMock.mock.calls[0][0].query).toEqual(HORIZON)
    expect([...enriched.horizon.projectIds].sort()).toEqual(["proj-1", "proj-2"])
    expect(enriched.horizon.complete).toBe(true)
  })

  it("reports an incomplete horizon when the appointment fetch fails", async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    getAllJobAppointmentsInPeriodMock.mockRejectedValue(new Error("boom 400"))

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.horizon.complete).toBe(false)
    expect(enriched.horizon.reason).toContain("Planungshorizont")
  })

  it("reports an incomplete horizon instead of firing hundreds of single lookups", async () => {
    // Der Zeitraum-Abruf kennt die Aufträge des Horizonts nicht (z. B. weil er
    // nach Fälligkeits- statt Termindatum filtert).
    getAllJobsInPeriodMock.mockResolvedValue([])
    getAllJobAppointmentsInPeriodMock.mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => appointment(100 + i)),
    )

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.horizon.complete).toBe(false)
    expect(enriched.horizon.reason).toContain("Limit")
    // Nur die 10 Tagesaufträge wurden einzeln geladen, nicht die 250
    expect(getJobByIdMock).toHaveBeenCalledTimes(10)
  })

  it("resolves a handful of unknown horizon jobs individually", async () => {
    getAllJobAppointmentsInPeriodMock.mockResolvedValue([
      ...jobIds(10).map((_, i) => appointment(i)),
      appointment(42, { date: "2026-08-20T07:00:00" }),
    ])

    const enriched = await enrich(stubClient, bulkOptions())

    expect(enriched.horizon.complete).toBe(true)
    expect(enriched.horizon.projectIds.has("proj-42")).toBe(true)
  })
})
