import { beforeEach, describe, expect, it, vi } from "vitest"

const searchForEmployeesMock = vi.fn()

vi.mock("@miranum/client-clockin", () => ({
  sdk: { searchForEmployees: searchForEmployeesMock },
}))

const { EmployeeMatcher } = await import("./employees.js")
const { log } = await import("../lib/log.js")

const stubClient = {} as never
const silentLog = log.child({ test: true })
;(silentLog as unknown as { warn: () => void }).warn = () => {
  /* swallow */
}

beforeEach(() => {
  searchForEmployeesMock.mockReset()
})

describe("EmployeeMatcher.match", () => {
  it("stage 1: returns the only candidate when lastName matches uniquely", async () => {
    searchForEmployeesMock.mockResolvedValue({
      data: [{ id: 42, first_name: "Anna", last_name: "Müller" }],
    })

    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({ id: "d1", firstName: "Anna", lastName: "Müller" })

    expect(m?.clockinId).toBe(42)
    expect(searchForEmployeesMock).toHaveBeenCalledTimes(1)
  })

  it("stage 2: filters by firstName when lastName has multiple hits", async () => {
    searchForEmployeesMock.mockResolvedValue({
      data: [
        { id: 1, first_name: "Hans", last_name: "Müller" },
        { id: 2, first_name: "Anna", last_name: "Müller" },
      ],
    })

    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({ id: "d2", firstName: "anna", lastName: "Müller" })

    expect(m?.clockinId).toBe(2)
  })

  it("stage 3: falls back to email when firstName + lastName collide", async () => {
    searchForEmployeesMock.mockResolvedValue({
      data: [
        { id: 1, first_name: "Anna", last_name: "Müller", email: "anna1@example.com" },
        { id: 2, first_name: "Anna", last_name: "Müller", email: "anna2@example.com" },
      ],
    })

    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({
      id: "d3",
      firstName: "Anna",
      lastName: "Müller",
      email: "anna2@example.com",
    })

    expect(m?.clockinId).toBe(2)
  })

  it("returns null when no candidate matches", async () => {
    searchForEmployeesMock.mockResolvedValue({ data: [] })
    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({ id: "d4", firstName: "X", lastName: "Y" })
    expect(m).toBeNull()
  })

  it("returns null when ambiguity remains after all stages", async () => {
    searchForEmployeesMock.mockResolvedValue({
      data: [
        { id: 1, first_name: "Anna", last_name: "Müller", email: "x@y.com" },
        { id: 2, first_name: "Anna", last_name: "Müller", email: "x@y.com" },
      ],
    })

    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const m = await matcher.match({
      id: "d5",
      firstName: "Anna",
      lastName: "Müller",
      email: "x@y.com",
    })
    expect(m).toBeNull()
  })

  it("caches the mapping per dimacon employee id", async () => {
    searchForEmployeesMock.mockResolvedValue({
      data: [{ id: 99, first_name: "Bo", last_name: "Z" }],
    })

    const matcher = new EmployeeMatcher(stubClient, silentLog)
    const employee = { id: "same", firstName: "Bo", lastName: "Z" }
    await matcher.match(employee)
    await matcher.match(employee)

    expect(searchForEmployeesMock).toHaveBeenCalledTimes(1)
  })
})
