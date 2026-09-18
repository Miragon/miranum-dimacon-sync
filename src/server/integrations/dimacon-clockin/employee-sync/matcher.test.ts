import { describe, expect, it } from "vitest"
import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
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
      [clk({ personnelNumber: "p-100 ", firstName: "Anna" })],
    )
    expect(outcome.pairs).toHaveLength(1)
    expect(outcome.dimaconOnly).toHaveLength(0)
    expect(outcome.clockinOnly).toHaveLength(0)
  })

  it("never pairs by name or email alone", () => {
    const outcome = matchEmployees(
      [dim({ email: "anna@example.com" })],
      [clk({ email: "Anna@Example.com" })],
    )
    expect(outcome.pairs).toHaveLength(0)
    expect(outcome.dimaconOnly.map((e) => e.id)).toEqual(["d1"])
    expect(outcome.clockinOnly.map((c) => c.id)).toEqual([1])
  })

  it("does not pair on a differently formatted personnel number", () => {
    // Führende Nullen sind Teil der Nummer — „30" und „00030" bleiben
    // verschieden; die Anlage-Bremse fängt den Fall per Namen ab.
    const outcome = matchEmployees(
      [dim({ personnelNumber: "30" })],
      [clk({ personnelNumber: "00030" })],
    )
    expect(outcome.pairs).toHaveLength(0)
  })

  it("lets the active record win over archived name twins without personnel number", () => {
    // Echte Konstellation: zwei archivierte Alt-Datensätze ohne PNr stehen in
    // der Liste VOR dem aktiven Datensatz. Früher griff sich der erste
    // archivierte über den Namen den Clockin-Mitarbeiter, und der aktive
    // sollte ein zweites Mal in Clockin angelegt werden.
    const outcome = matchEmployees(
      [
        dim({ id: "old-1", isArchived: true }),
        dim({ id: "old-2", isArchived: true }),
        dim({ id: "active", personnelNumber: "00011" }),
      ],
      [clk({ id: 101, personnelNumber: "00011" })],
    )

    expect(outcome.pairs.map((p) => [p.dimacon.id, p.clockin.id])).toEqual([["active", 101]])
    expect(outcome.dimaconOnly).toHaveLength(0)
    expect(outcome.clockinOnly).toHaveLength(0)
  })

  it("lets the active record win over an archived record with the same personnel number", () => {
    const outcome = matchEmployees(
      [
        dim({ id: "old", personnelNumber: "P-5", isArchived: true }),
        dim({ id: "active", personnelNumber: "P-5" }),
      ],
      [clk({ id: 1, personnelNumber: "P-5" })],
    )

    expect(outcome.pairs.map((p) => p.dimacon.id)).toEqual(["active"])
  })

  it("treats multiple candidates as ambiguous instead of guessing", () => {
    const outcome = matchEmployees(
      [dim({ personnelNumber: "P-1" })],
      [clk({ id: 1, personnelNumber: "P-1" }), clk({ id: 2, personnelNumber: "P-1" })],
    )
    expect(outcome.pairs).toHaveLength(0)
    expect(outcome.ambiguous).toHaveLength(1)
    expect(outcome.ambiguous[0].reason).toBe("2 Clockin-Mitarbeiter mit Personalnummer P-1")
    // beide Clockin-Kandidaten bleiben unverbraucht
    expect(outcome.clockinOnly).toHaveLength(2)
    // mehrdeutig heißt nicht „fehlt in Clockin"
    expect(outcome.dimaconOnly).toHaveLength(0)
  })

  it("blocks both candidates of an ambiguous match as creation candidates", () => {
    const outcome = matchEmployees(
      [dim({ personnelNumber: "P-1" })],
      [clk({ id: 1, personnelNumber: "P-1" }), clk({ id: 2, personnelNumber: "P-1" })],
    )

    // clockinOnly bleibt unverändert — nur die Anlage-Policy filtert später
    expect(outcome.clockinOnly.map((c) => c.id)).toEqual([1, 2])
    expect(outcome.blockedClockinIds.get(1)).toContain("mehrdeutig")
    expect(outcome.blockedClockinIds.get(2)).toContain("mehrdeutig")
  })

  it("blocks a clockin duplicate of an already matched record", () => {
    const outcome = matchEmployees(
      [dim({ personnelNumber: "P-1" })],
      [
        clk({ id: 1, personnelNumber: "P-1" }),
        // gleiche Person, zweiter Datensatz ohne Personalnummer
        clk({ id: 2 }),
      ],
    )

    expect(outcome.pairs.map((p) => p.clockin.id)).toEqual([1])
    expect(outcome.clockinOnly.map((c) => c.id)).toEqual([2])
    expect(outcome.blockedClockinIds.get(2)).toBe(
      "Dublette in Clockin zu bereits zugeordnetem Datensatz #1",
    )
  })

  it("blocks a clockin duplicate even when neither record is matched", () => {
    // Beide Datensätze sind Dubletten derselben Person und in Dimacon
    // unbekannt — ohne Sperre würden zwei neue Dimacon-Mitarbeiter entstehen.
    const outcome = matchEmployees(
      [],
      [
        clk({ id: 1, firstName: "Max", lastName: "Mustermann", personnelNumber: "P-9" }),
        clk({ id: 2, firstName: "Max", lastName: "Mustermann", personnelNumber: "P-9" }),
      ],
    )

    expect(outcome.pairs).toHaveLength(0)
    expect(outcome.clockinOnly.map((c) => c.id)).toEqual([1, 2])
    // Der erste Datensatz bleibt Anlage-Kandidat, der zweite ist gesperrt
    expect(outcome.blockedClockinIds.has(1)).toBe(false)
    expect(outcome.blockedClockinIds.get(2)).toBe("Dublette in Clockin zu Datensatz #1")
  })

  it("blocks an unmatched clockin duplicate that only shares the name", () => {
    const outcome = matchEmployees(
      [],
      [
        clk({ id: 1, firstName: "Max", lastName: "Mustermann", personnelNumber: "P-9" }),
        clk({ id: 2, firstName: "Max", lastName: "Mustermann", personnelNumber: "P-10" }),
      ],
    )

    expect(outcome.blockedClockinIds.get(2)).toBe("Dublette in Clockin zu Datensatz #1")
  })

  it("leaves genuinely new clockin employees unblocked", () => {
    const outcome = matchEmployees(
      [dim({ personnelNumber: "P-1" })],
      [clk({ personnelNumber: "P-1" }), clk({ id: 9, lastName: "Beta", personnelNumber: "P-9" })],
    )

    expect(outcome.clockinOnly.map((c) => c.id)).toEqual([9])
    expect(outcome.blockedClockinIds.size).toBe(0)
  })

  it("skips archived dimacon employees as creation candidates", () => {
    const outcome = matchEmployees([dim({ isArchived: true })], [])
    expect(outcome.dimaconOnly).toHaveLength(0)
    expect(outcome.pairs).toHaveLength(0)
  })

  it("still matches archived dimacon employees to existing clockin employees", () => {
    const outcome = matchEmployees(
      [dim({ isArchived: true, personnelNumber: "P-1" })],
      [clk({ personnelNumber: "P-1" })],
    )
    expect(outcome.pairs).toHaveLength(1)
  })

  it("collects unmatched employees per side", () => {
    const outcome = matchEmployees(
      [dim({ id: "d1", personnelNumber: "P-1" })],
      [clk({ id: 9, personnelNumber: "P-9" })],
    )
    expect(outcome.dimaconOnly.map((e) => e.id)).toEqual(["d1"])
    expect(outcome.clockinOnly.map((c) => c.id)).toEqual([9])
  })

  it("never matches the same clockin employee twice", () => {
    const outcome = matchEmployees(
      [dim({ id: "d1", personnelNumber: "P-1" }), dim({ id: "d2", personnelNumber: "P-1" })],
      [clk({ id: 1, personnelNumber: "P-1" })],
    )
    expect(outcome.pairs).toHaveLength(1)
    expect(outcome.dimaconOnly.map((e) => e.id)).toEqual(["d2"])
  })
})

describe("diffPair", () => {
  it("reports no changes for equal pairs", () => {
    const diff = diffPair(dim({ personnelNumber: "P-1" }), clk({ personnelNumber: "P-1" }))
    expect(diff.clockinChanges).toEqual([])
  })

  it("flags name fields that deviate from dimacon", () => {
    const diff = diffPair(
      dim({ firstName: "Anna-Lena", lastName: "Neu", personnelNumber: "P-1" }),
      clk({ firstName: "Anna", personnelNumber: "P-1" }),
    )
    expect(diff.clockinChanges).toEqual(["firstName", "lastName"])
  })

  it("ignores non-key fields — those run through the field mapping", () => {
    const diff = diffPair(dim({ phoneNumber: "0151 123" }), clk({ phoneWork: "0151 999" }))
    expect(diff.clockinChanges).toEqual([])
  })
})
