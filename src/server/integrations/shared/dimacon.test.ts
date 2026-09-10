import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getAllEmployeesMock = vi.fn()
const getAllUsersMock = vi.fn()
const getCustomerByIdMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: {
    getAllEmployees: getAllEmployeesMock,
    getAllUsers: getAllUsersMock,
    getCustomerById: getCustomerByIdMock,
  },
}))

const { loadCustomersById, loadEmployeesWithEmail } = await import("./dimacon.js")

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
