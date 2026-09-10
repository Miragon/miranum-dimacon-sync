import { beforeEach, describe, expect, it, vi } from "vitest"

const getAllEmployeesMock = vi.fn()
const getAllUsersMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: { getAllEmployees: getAllEmployeesMock, getAllUsers: getAllUsersMock },
}))

const { loadEmployeesWithEmail } = await import("./dimacon.js")

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
