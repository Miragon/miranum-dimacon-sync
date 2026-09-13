import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../../lib/log.js"
import type { EntityMappingContext } from "../../shared/mapping-context.js"
import type { ClockinEmployeeInfo } from "./types.js"

// --- Dimacon-SDK: Laden UND Schreiben laufen über dieselben Mocks ---
const getAllEmployeesMock = vi.fn()
const getAllUsersMock = vi.fn()
const dimaconUpdateEmployeeMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: {
    getAllEmployees: getAllEmployeesMock,
    getAllUsers: getAllUsersMock,
    updateEmployee: dimaconUpdateEmployeeMock,
  },
}))

const clockinUpdateEmployeeMock = vi.fn()
vi.mock("@miragon/client-clockin", () => ({
  sdk: { updateEmployee: clockinUpdateEmployeeMock },
}))

// Bewusst OHNE Mock von shared/dimacon.js: getestet wird die ganze Kette
// Loader → Matcher → PUT-Body.
const { loadEmployeesWithEmail } = await import("../../shared/dimacon.js")
const { matchEmployees } = await import("./matcher.js")
const { EmployeeSyncer } = await import("./syncer.js")
const { FIELD_CATALOG } = await import("../../shared/field-catalog.js")
const { EMPTY_DISCOVERY } = await import("../../shared/field-mapping.js")

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

const mapping: EntityMappingContext = {
  entity: "employee",
  rules: FIELD_CATALOG.employee.defaultRules,
  catalog: FIELD_CATALOG.employee,
  discovery: EMPTY_DISCOVERY,
  isCustomized: false,
  hasCustomTargets: false,
}

const stubClient = {} as never

const clockinEmployee: ClockinEmployeeInfo = {
  id: 5,
  firstName: "Anna",
  lastName: "Muster",
  personnelNumber: "P-42",
  phoneWork: "0170 1",
  raw: { phone_work: "0170 1" },
}

beforeEach(() => {
  vi.resetAllMocks()
  getAllUsersMock.mockResolvedValue([])
  dimaconUpdateEmployeeMock.mockResolvedValue({})
  clockinUpdateEmployeeMock.mockResolvedValue({})
})

describe("Personalnummer-Backfill (Loader → PUT-Body)", () => {
  it("echoes every loaded field back so the full replace keeps the team", async () => {
    // Rohressource aus Dimacon — der Mitarbeiter hat ein Team, aber noch
    // keine Personalnummer (Issue #17: genau dieser Fall hat das Team gelöscht).
    getAllEmployeesMock.mockResolvedValue([
      {
        id: "e-1",
        firstName: "Anna",
        lastName: "Muster",
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

    const dimaconEmployees = await loadEmployeesWithEmail(stubClient)
    const outcome = matchEmployees(dimaconEmployees, [clockinEmployee])
    expect(outcome.pairs).toHaveLength(1)

    const syncer = new EmployeeSyncer(stubClient, stubClient, silentLog, false, mapping)
    const row = await syncer.alignPair(outcome.pairs[0])

    expect(row.status).toBe("updated")
    // Clockin bleibt unangetastet — nur die Personalnummer geht nach Dimacon
    expect(clockinUpdateEmployeeMock).not.toHaveBeenCalled()
    expect(dimaconUpdateEmployeeMock).toHaveBeenCalledTimes(1)
    expect(dimaconUpdateEmployeeMock.mock.calls[0][0].body).toEqual({
      role: "CRAFTSMAN",
      firstName: "Anna",
      lastName: "Muster",
      personnelNumber: "P-42",
      phoneNumber: "0170 1",
      team: "Team Nord",
      profilePicture: "pic-1",
      color: "#A1A1AA",
      timeTrackingActive: true,
      additionalInformation: "Zusatzinfo",
    })
  })
})
