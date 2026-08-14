import { describe, expect, it } from "vitest"
import type { DimaconEmployeeFull } from "../shared/dimacon.js"
import { diffPair, matchEmployees } from "./matcher.js"
import type { ClockinEmployeeInfo } from "./types.js"

function dim(overrides: Partial<DimaconEmployeeFull> = {}): DimaconEmployeeFull {
  return {
    id: "d1",
    firstName: "Anna",
    lastName: "Muster",
    role: "CRAFTSMAN",
    color: "#A1A1AA",
    timeTrackingActive: true,
    isArchived: false,
    ...overrides,
  }
}

function clk(overrides: Partial<ClockinEmployeeInfo> = {}): ClockinEmployeeInfo {
  return {
    id: 1,
    firstName: "Anna",
    lastName: "Muster",
    ...overrides,
  }
}

describe("matchEmployees", () => {
  it("matches by personnel number even when names differ", () => {
    const outcome = matchEmployees(
      [dim({ personnelNumber: "P-100", firstName: "Anna-Lena" })],
      [clk({ personnelNumber: "P-100", firstName: "Anna" })],
    )
    expect(outcome.pairs).toHaveLength(1)
    expect(outcome.pairs[0].matchedBy).toBe("personnelNumber")
    expect(outcome.dimaconOnly).toHaveLength(0)
    expect(outcome.clockinOnly).toHaveLength(0)
  })

  it("falls back to email, then to name", () => {
    const byEmail = matchEmployees(
      [dim({ email: "anna@example.com", lastName: "Meier" })],
      [clk({ email: "Anna@Example.com", lastName: "Mustermann" })],
    )
    expect(byEmail.pairs[0]?.matchedBy).toBe("email")

    const byName = matchEmployees([dim()], [clk()])
    expect(byName.pairs[0]?.matchedBy).toBe("name")
  })

  it("treats multiple candidates as ambiguous instead of guessing", () => {
    const outcome = matchEmployees([dim()], [clk({ id: 1 }), clk({ id: 2 })])
    expect(outcome.pairs).toHaveLength(0)
    expect(outcome.ambiguous).toHaveLength(1)
    expect(outcome.ambiguous[0].reason).toContain("2 Clockin-Kandidaten")
    // beide Clockin-Kandidaten bleiben unverbraucht
    expect(outcome.clockinOnly).toHaveLength(2)
  })

  it("does not fall through to the next pass after an ambiguous hit", () => {
    const outcome = matchEmployees(
      [dim({ personnelNumber: "P-1" })],
      [
        clk({ id: 1, personnelNumber: "P-1", firstName: "X", lastName: "Y" }),
        clk({ id: 2, personnelNumber: "P-1", firstName: "Anna", lastName: "Muster" }),
      ],
    )
    expect(outcome.pairs).toHaveLength(0)
    expect(outcome.ambiguous).toHaveLength(1)
  })

  it("skips archived dimacon employees as creation candidates", () => {
    const outcome = matchEmployees([dim({ isArchived: true })], [])
    expect(outcome.dimaconOnly).toHaveLength(0)
    expect(outcome.pairs).toHaveLength(0)
  })

  it("still matches archived dimacon employees to existing clockin employees", () => {
    const outcome = matchEmployees([dim({ isArchived: true })], [clk()])
    expect(outcome.pairs).toHaveLength(1)
  })

  it("collects unmatched employees per side", () => {
    const outcome = matchEmployees(
      [dim({ id: "d1", lastName: "Alpha" })],
      [clk({ id: 9, lastName: "Beta" })],
    )
    expect(outcome.dimaconOnly.map((e) => e.id)).toEqual(["d1"])
    expect(outcome.clockinOnly.map((c) => c.id)).toEqual([9])
  })

  it("never matches the same clockin employee twice", () => {
    const outcome = matchEmployees([dim({ id: "d1" }), dim({ id: "d2" })], [clk({ id: 1 })])
    expect(outcome.pairs).toHaveLength(1)
    expect(outcome.dimaconOnly.map((e) => e.id)).toEqual(["d2"])
  })
})

describe("diffPair", () => {
  it("reports no changes for equal pairs", () => {
    const diff = diffPair(dim({ personnelNumber: "P-1" }), clk({ personnelNumber: "P-1" }))
    expect(diff.clockinChanges).toEqual([])
    expect(diff.backfillPersonnelNumber).toBeUndefined()
  })

  it("flags match-key fields that deviate from dimacon", () => {
    const diff = diffPair(
      dim({ firstName: "Anna-Lena", personnelNumber: "P-1" }),
      clk({ firstName: "Anna", personnelNumber: "P-2" }),
    )
    expect(diff.clockinChanges).toEqual(["firstName", "personnelNumber"])
  })

  it("ignores non-key fields — those run through the field mapping", () => {
    const diff = diffPair(dim({ phoneNumber: "0151 123" }), clk({ phoneWork: "0151 999" }))
    expect(diff.clockinChanges).toEqual([])
  })

  it("backfills a missing dimacon personnel number from clockin", () => {
    const diff = diffPair(dim(), clk({ personnelNumber: "P-7" }))
    expect(diff.backfillPersonnelNumber).toBe("P-7")
    expect(diff.clockinChanges).toEqual([])
  })
})
