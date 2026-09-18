import { beforeEach, describe, expect, it, vi } from "vitest"

const searchForEmployeesMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: { searchForEmployees: searchForEmployeesMock },
}))

const { EmployeeMatcher } = await import("./employees.js")
const { log } = await import("../../lib/log.js")

const stubClient = {} as never
const silentLog = log.child({ test: true })
;(silentLog as unknown as { warn: () => void }).warn = () => {
  /* swallow */
}

beforeEach(() => {
  searchForEmployeesMock.mockReset()
})

describe("EmployeeMatcher.match", () => {
  it("returns a seeded pair without hitting the clockin search", async () => {
    const matcher = new EmployeeMatcher(stubClient, silentLog, new Map([["d1", 77]]))
    const m = await matcher.match({ id: "d1", firstName: "Anna", lastName: "Müller" })

    expect(m).toEqual({ dimaconId: "d1", clockinId: 77, firstName: "Anna", lastName: "Müller" })
    expect(searchForEmployeesMock).not.toHaveBeenCalled()
  })

  it("falls back to the personnel-number search for unseeded ids", async () => {
    searchForEmployeesMock.mockResolvedValue({ data: [{ id: 42, personnel_number: "00030" }] })

    const matcher = new EmployeeMatcher(stubClient, silentLog, new Map([["other-id", 77]]))
    const m = await matcher.match({
      id: "d1",
      firstName: "Anna",
      lastName: "Müller",
      personnelNumber: "00030",
    })

    expect(m?.clockinId).toBe(42)
    expect(searchForEmployeesMock).toHaveBeenCalledTimes(1)
    expect(searchForEmployeesMock.mock.calls[0][0].body).toEqual({
      scopes: [{ name: "byPersonnelNumber", parameters: ["00030"] }],
    })
  })

  it("does not search by name when the dimacon employee has no personnel number", async () => {
    // Früher: Nachnamen-Suche, ein einzelner Treffer galt ohne Vornamen-
    // Prüfung als Match — jeder „Müller" in Clockin wäre es gewesen.
    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({ id: "d1", firstName: "Anna", lastName: "Müller" })

    expect(m).toBeNull()
    expect(searchForEmployeesMock).not.toHaveBeenCalled()
  })

  it("accepts only exact personnel-number hits from the server", async () => {
    // Der Scope kennt Wildcards — eine unscharfe Antwort darf nie treffen.
    searchForEmployeesMock.mockResolvedValue({
      data: [
        { id: 1, personnel_number: "000300" },
        { id: 2, personnel_number: " 00030 " },
      ],
    })

    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({
      id: "d2",
      firstName: "Anna",
      lastName: "Müller",
      personnelNumber: "00030",
    })

    expect(m?.clockinId).toBe(2)
  })

  it("returns null when no candidate matches", async () => {
    searchForEmployeesMock.mockResolvedValue({ data: [] })
    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({
      id: "d4",
      firstName: "X",
      lastName: "Y",
      personnelNumber: "P-4",
    })
    expect(m).toBeNull()
  })

  it("returns null when two clockin employees share the personnel number", async () => {
    searchForEmployeesMock.mockResolvedValue({
      data: [
        { id: 1, personnel_number: "P-5" },
        { id: 2, personnel_number: "P-5" },
      ],
    })

    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({
      id: "d5",
      firstName: "A",
      lastName: "B",
      personnelNumber: "P-5",
    })
    expect(m).toBeNull()
  })

  it("caches the mapping per dimacon employee id", async () => {
    searchForEmployeesMock.mockResolvedValue({ data: [{ id: 99, personnel_number: "P-9" }] })

    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const employee = { id: "same", firstName: "Bo", lastName: "Z", personnelNumber: "P-9" }
    await matcher.match(employee)
    await matcher.match(employee)

    expect(searchForEmployeesMock).toHaveBeenCalledTimes(1)
  })
})
