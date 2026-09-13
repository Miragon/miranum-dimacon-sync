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
    ).toBe("3 von 5 Schritten · dry-run")
  })

  it("reads the untouched default scope as the full scope", () => {
    // LOAD-BEARING: der Opt-in-Schritt (Default aus) ist kein abgeschalteter
    // Schritt — sonst läse der Normalzustand als „5 von 6" und widerspräche
    // isDefaultScope und den Badges aus step-badges.ts (Issue #17).
    expect(describeScope(CLOCKIN, {})).toBe("voll · live")
    expect(isDefaultScope(CLOCKIN, {})).toBe(true)
  })

  it("names an enabled opt-in step instead of folding it into the full scope", () => {
    const scope = { dryRun: false, steps: { employeeCreateInDimacon: true } }
    expect(describeScope(CLOCKIN, scope)).toBe("voll + 1 Zusatzschritt · live")
    expect(isDefaultScope(CLOCKIN, scope)).toBe(false)
  })

  it("ignores an enabled opt-in step whose prerequisite is off", () => {
    // Ohne `employees` führt der Server die Dimacon-Anlage nicht aus
    // (dimacon-clockin/run.ts) und `hints` meldet sie nicht — dann darf das
    // Label sie auch nicht behaupten (Altdaten/API-PUT, siehe Issue #12).
    const scope = { steps: { employees: false, employeeCreateInDimacon: true } }
    expect(describeScope(CLOCKIN, scope)).toBe("4 von 5 Schritten · live")
  })

  it("combines a reduced scope with an enabled opt-in step", () => {
    expect(
      describeScope(CLOCKIN, {
        dryRun: true,
        steps: { archive: false, employeeCreateInDimacon: true },
      }),
    ).toBe("4 von 5 Schritten + 1 Zusatzschritt · dry-run")
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
    expect(hints.some((h) => h.includes("auch in Dimacon Mitarbeiter an"))).toBe(false)
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
    expect(hints.some((h) => h.includes("auch in Dimacon Mitarbeiter an"))).toBe(true)
  })

  it("switches the lexoffice hint with createContacts", () => {
    const spec = RUN_SCOPE_SPECS[LEXOFFICE]
    expect(spec.hints({ createContacts: true, alignNumbers: true })[0]).toMatch(
      /gesamten Dimacon-Kundenbestand/,
    )
    expect(spec.hints({ createContacts: false, alignNumbers: true })[0]).toMatch(/Nur Abgleich/)
  })
})

/**
 * Die Bedingungen der heiklen Schritte hängen nicht am Schaltzustand: Sie
 * stehen als `note` am Schritt selbst und werden von StepNotes immer
 * gerendert. Ohne das erfährt man den Relevanzfilter erst aus den
 * übersprungenen Zeilen im Ergebnis — und hält ihn dort für einen Fehler.
 */
describe("Bedingungen am Schritt (note)", () => {
  it("nennt beim Anlegen in Dimacon die Personalnummer-Regel", () => {
    const step = RUN_SCOPE_SPECS[CLOCKIN].steps.find((s) => s.key === "employeeCreateInDimacon")
    expect(step?.note).toMatch(/Personalnummer/)
    expect(step?.note).toMatch(/OHNE Team/)
  })

  it("nennt beim Archivieren den Planungshorizont", () => {
    const step = RUN_SCOPE_SPECS[CLOCKIN].steps.find((s) => s.key === "archive")
    expect(step?.note).toMatch(/Planungshorizont/)
  })

  it("nennt bei der Lexware-Anlage die Mehrdeutigkeits-Regel", () => {
    const step = RUN_SCOPE_SPECS[LEXOFFICE].steps.find((s) => s.key === "createContacts")
    expect(step?.note).toMatch(/gleichnamige/)
  })
})
