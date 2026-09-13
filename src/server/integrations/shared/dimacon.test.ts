import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getAllEmployeesMock = vi.fn()
const getAllUsersMock = vi.fn()
const getCustomerByIdMock = vi.fn()
const getAllJobsInPeriodMock = vi.fn()
const getCurrentTeamAssignmentsMock = vi.fn()
const getAllProjectsMock = vi.fn()
const getProjectByIdMock = vi.fn()
const getAllJobAppointmentsInPeriodMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: {
    getAllEmployees: getAllEmployeesMock,
    getAllUsers: getAllUsersMock,
    getCustomerById: getCustomerByIdMock,
    getAllJobsInPeriod: getAllJobsInPeriodMock,
    getCurrentTeamAssignments: getCurrentTeamAssignmentsMock,
    getAllProjects: getAllProjectsMock,
    getProjectById: getProjectByIdMock,
    getAllJobAppointmentsInPeriod: getAllJobAppointmentsInPeriodMock,
  },
}))

const {
  loadAllProjects,
  loadAppointments,
  loadCustomersById,
  loadEmployeesWithEmail,
  loadJobsInPeriod,
  loadProjectsById,
  loadTeamAssignmentsInPeriod,
} = await import("./dimacon.js")

const stubClient = {} as never

/**
 * Diese Felder MÜSSEN geladen werden, damit `dimaconEmployeeUpdateBody` sie
 * beim Voll-Replace-PUT zurückspiegeln kann (Issue #17 — sonst verlieren
 * Mitarbeiter beim Personalnummer-Backfill ihr Team).
 */
const ECHOED_FIELDS = [
  "role",
  "firstName",
  "lastName",
  "personnelNumber",
  "phoneNumber",
  "team",
  "profilePicture",
  "color",
  "timeTrackingActive",
  "additionalInformation",
] as const

beforeEach(() => {
  vi.resetAllMocks()
  getAllUsersMock.mockResolvedValue([])
})

describe("loadEmployeesWithEmail", () => {
  it("passes every field of the raw resource through", async () => {
    getAllEmployeesMock.mockResolvedValue([
      {
        id: "e-1",
        firstName: "Anna",
        lastName: "Muster",
        personnelNumber: "P-1",
        phoneNumber: "0170 1",
        team: "Team Nord",
        additionalInformation: "Zusatzinfo",
        profilePicture: "pic-1",
        role: "CRAFTSMAN",
        color: "#A1A1AA",
        timeTrackingActive: true,
        isArchived: false,
      },
    ])
    getAllUsersMock.mockResolvedValue([{ employeeId: "e-1", emailAddress: "anna@example.com" }])

    const [employee] = await loadEmployeesWithEmail(stubClient)

    expect(employee).toEqual({
      id: "e-1",
      firstName: "Anna",
      lastName: "Muster",
      personnelNumber: "P-1",
      phoneNumber: "0170 1",
      team: "Team Nord",
      additionalInformation: "Zusatzinfo",
      profilePicture: "pic-1",
      role: "CRAFTSMAN",
      color: "#A1A1AA",
      timeTrackingActive: true,
      isArchived: false,
      email: "anna@example.com",
    })
    // Regressionsschutz: kein rückzuspiegelndes Feld darf beim Laden wegfallen
    for (const field of ECHOED_FIELDS) {
      expect(employee[field], `Feld ${field} fehlt im geladenen Mitarbeiter`).toBeDefined()
    }
  })

  it("leaves the email undefined without a matching user account", async () => {
    getAllEmployeesMock.mockResolvedValue([
      {
        id: "e-2",
        firstName: "Bert",
        lastName: "Bauer",
        role: "CRAFTSMAN",
        color: "#A1A1AA",
        timeTrackingActive: true,
        isArchived: true,
      },
    ])
    getAllUsersMock.mockResolvedValue([{ employeeId: "e-1", emailAddress: "anna@example.com" }])

    const [employee] = await loadEmployeesWithEmail(stubClient)

    expect(employee.email).toBeUndefined()
    expect(employee.isArchived).toBe(true)
  })
})

describe("Parallelität der Dimacon-Loader", () => {
  afterEach(() => {
    delete process.env.CONCURRENCY_DIMACON
  })

  /** Höchste Zahl gleichzeitig offener SDK-Aufrufe. */
  async function peakInFlight(ids: string[]): Promise<number> {
    let inFlight = 0
    let peak = 0
    getCustomerByIdMock.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 0))
      inFlight--
      return { id: "c" }
    })
    await loadCustomersById(stubClient, ids)
    return peak
  }

  const ids = Array.from({ length: 30 }, (_, i) => `c-${i}`)

  it("nutzt den Dimacon-Default statt der globalen 3", async () => {
    // Regressionsschutz gegen `createLimit()` ohne System — sonst wäre
    // CONCURRENCY_DIMACON (README, env.example) wirkungslose Konfiguration.
    expect(await peakInFlight(ids)).toBe(8)
  })

  it("folgt dem Env-Override CONCURRENCY_DIMACON", async () => {
    process.env.CONCURRENCY_DIMACON = "2"
    expect(await peakInFlight(ids)).toBe(2)
  })
})

describe("Sammelabrufe (#15)", () => {
  it("loadJobsInPeriod braucht genau einen Request und trägt die Termine mit", async () => {
    getAllJobsInPeriodMock.mockResolvedValue([
      {
        id: "job-1",
        projectId: "proj-1",
        customerId: "cust-1",
        appointments: [
          { id: "a-1", jobId: "job-1", teamId: "team-1", date: "2026-08-14", isArchived: false },
        ],
      },
      { id: "job-2", projectId: "proj-2", customerId: "cust-2" },
    ])

    const jobs = await loadJobsInPeriod(stubClient, "2026-08-14", "2026-08-15")

    expect(getAllJobsInPeriodMock).toHaveBeenCalledTimes(1)
    expect(getAllJobsInPeriodMock.mock.calls[0][0].query).toEqual({
      from: "2026-08-14",
      to: "2026-08-15",
    })
    expect(jobs).toEqual([
      {
        jobId: "job-1",
        projectId: "proj-1",
        customerId: "cust-1",
        appointments: [
          { id: "a-1", jobId: "job-1", teamId: "team-1", date: "2026-08-14", isArchived: false },
        ],
      },
      // Ohne `appointments` in der Antwort: leeres Array statt undefined
      { jobId: "job-2", projectId: "proj-2", customerId: "cust-2", appointments: [] },
    ])
  })

  it("loadTeamAssignmentsInPeriod reicht die Zuweisungen des Zeitraums durch", async () => {
    getCurrentTeamAssignmentsMock.mockResolvedValue([
      { id: "ta-1", teamId: "team-1", employeeId: "e-1", date: "2026-08-14", isFixed: true },
    ])

    const rows = await loadTeamAssignmentsInPeriod(stubClient, "2026-08-14", "2026-08-15")

    expect(getCurrentTeamAssignmentsMock.mock.calls[0][0].query).toEqual({
      from: "2026-08-14",
      to: "2026-08-15",
    })
    expect(rows.map((r) => r.employeeId)).toEqual(["e-1"])
  })

  it("loadAllProjects liefert dieselbe Form wie getProjectById", async () => {
    const row = { id: "p-1", name: "Projekt", street: "Weg 1", zipCity: "80331 München" }
    getAllProjectsMock.mockResolvedValue([row])
    getProjectByIdMock.mockResolvedValue(row)

    expect(await loadAllProjects(stubClient)).toEqual([row])
    expect(await loadProjectsById(stubClient, ["p-1"])).toEqual([row])
  })

  it("loadAppointments filtert weiterhin auf das angefragte Datum", async () => {
    getAllJobAppointmentsInPeriodMock.mockResolvedValue([
      { id: "a-1", jobId: "job-1", teamId: "t", date: "2026-08-14T07:00:00", isArchived: false },
      { id: "a-2", jobId: "job-2", teamId: "t", date: "2026-08-14T07:00:00", isArchived: true },
      { id: "a-3", jobId: "job-3", teamId: "t", date: "2026-08-15T07:00:00", isArchived: false },
    ])

    const loaded = await loadAppointments(stubClient, "2026-08-14")

    expect(loaded.counts).toEqual({ total: 2, live: 1 })
    expect(loaded.jobIds).toEqual(["job-1"])
  })
})
