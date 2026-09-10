import { describe, expect, it } from "vitest"
import {
  describeScope,
  isDefaultScope,
  readScope,
  RUN_SCOPE_SPECS,
  toRunDefaults,
} from "./run-scope"

const CLOCKIN = "dimacon-clockin"
const LEXOFFICE = "dimacon-lexoffice"

describe("readScope", () => {
  it("falls back to the schema default of each step", () => {
    const scope = readScope(CLOCKIN, {}, { dryRunFallback: false })
    expect(scope.steps).toEqual({
      employees: true,
      // LOAD-BEARING: fehlender Key darf NIE zu „an" werden (Issue #17)
      employeeCreateInDimacon: false,
      customers: true,
      projects: true,
      assignments: true,
      archive: true,
    })
    expect(scope.dryRun).toBe(false)
  })

  it("respects the dryRun fallback per context", () => {
    expect(readScope(CLOCKIN, {}, { dryRunFallback: true }).dryRun).toBe(true)
    expect(readScope(CLOCKIN, {}, { dryRunFallback: false }).dryRun).toBe(false)
    // Ein gespeicherter Wert schlägt den Fallback in beide Richtungen
    expect(readScope(CLOCKIN, { dryRun: false }, { dryRunFallback: true }).dryRun).toBe(false)
    expect(readScope(CLOCKIN, { dryRun: true }, { dryRunFallback: false }).dryRun).toBe(true)
  })

  it("takes stored step values and ignores junk", () => {
    const scope = readScope(
      CLOCKIN,
      { steps: { employees: false, projects: "yes" } },
      { dryRunFallback: false },
    )
    expect(scope.steps.employees).toBe(false)
    expect(scope.steps.projects).toBe(true)
    expect(readScope(CLOCKIN, null, { dryRunFallback: true }).steps.employees).toBe(true)
  })

  it("returns an empty scope for integrations without a spec", () => {
    expect(readScope("unbekannt", {}, { dryRunFallback: true })).toEqual({
      dryRun: true,
      steps: {},
    })
  })
})

describe("toRunDefaults", () => {
  it("produces dryRun + steps and never a date", () => {
    const scope = readScope(LEXOFFICE, { dryRun: true }, { dryRunFallback: false })
    const defaults = toRunDefaults(scope)
    expect(defaults).toEqual({ dryRun: true, steps: { createContacts: true, alignNumbers: true } })
    expect(defaults).not.toHaveProperty("date")
  })
})

describe("describeScope / isDefaultScope", () => {
  it("labels the full live scope", () => {
    expect(
      describeScope(LEXOFFICE, {
        dryRun: false,
        steps: { createContacts: true, alignNumbers: true },
      }),
    ).toBe("voll · live")
  })

  it("counts partial scopes and marks dry-run", () => {
    expect(
      describeScope(CLOCKIN, {
        dryRun: true,
        steps: {
          employees: true,
          employeeCreateInDimacon: false,
          customers: true,
          projects: true,
          assignments: false,
          archive: false,
        },
      }),
    ).toBe("3 von 6 Schritten · dry-run")
  })

  it("treats an unset scope as the default", () => {
    expect(isDefaultScope(CLOCKIN, {})).toBe(true)
    expect(isDefaultScope(CLOCKIN, { dryRun: true })).toBe(false)
    expect(isDefaultScope(CLOCKIN, { steps: { archive: false } })).toBe(false)
    expect(isDefaultScope("unbekannt", { dryRun: true })).toBe(true)
  })

  it("returns a dash for unknown integrations", () => {
    expect(describeScope("unbekannt", {})).toBe("—")
  })
})

describe("hints", () => {
  it("always warns about the mass write of the employee sync", () => {
    const scope = readScope(CLOCKIN, {}, { dryRunFallback: false })
    const hints = RUN_SCOPE_SPECS[CLOCKIN].hints(scope.steps)
    expect(hints.some((h) => h.includes("gesamten Bestand beider Systeme"))).toBe(true)
    expect(hints.some((h) => h.includes("Legt Clockin-Mitarbeiter in Dimacon an"))).toBe(false)
  })

  it("adds the Dimacon creation warning only when that step is on", () => {
    const hints = RUN_SCOPE_SPECS[CLOCKIN].hints({
      employees: true,
      employeeCreateInDimacon: true,
      customers: true,
      projects: true,
      assignments: true,
      archive: true,
    })
    expect(hints.some((h) => h.includes("Legt Clockin-Mitarbeiter in Dimacon an"))).toBe(true)
  })

  it("switches the lexoffice hint with createContacts", () => {
    const spec = RUN_SCOPE_SPECS[LEXOFFICE]
    expect(spec.hints({ createContacts: true, alignNumbers: true })[0]).toMatch(
      /gesamten Dimacon-Kundenbestand/,
    )
    expect(spec.hints({ createContacts: false, alignNumbers: true })[0]).toMatch(/Nur Abgleich/)
  })
})
