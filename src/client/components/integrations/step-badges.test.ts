import { describe, expect, it } from "vitest"
import { stepBadges } from "./step-badges.js"

const DEFAULT_STEPS = {
  employees: true,
  customers: true,
  projects: true,
  assignments: true,
  archive: true,
  employeeCreateInDimacon: false,
}

describe("stepBadges", () => {
  it("shows no badge for a default run", () => {
    // Der Opt-in-Schalter ist per Default aus — das ist kein abgeschalteter
    // Schritt und darf keine Akzent-Rot-Badge erzeugen (Issue #17).
    expect(stepBadges(DEFAULT_STEPS)).toEqual([])
  })

  it("reports the enabled opt-in switch neutrally", () => {
    expect(stepBadges({ ...DEFAULT_STEPS, employeeCreateInDimacon: true })).toEqual([
      { key: "employeeCreateInDimacon", label: "anlage dimacon an", variant: "default" },
    ])
  })

  it("warns about disabled steps with a readable label", () => {
    expect(stepBadges({ ...DEFAULT_STEPS, archive: false, customers: false })).toEqual([
      { key: "customers", label: "kunden aus", variant: "warn" },
      { key: "archive", label: "archivierung aus", variant: "warn" },
    ])
  })

  it("falls back to the raw key for unknown steps and tolerates missing steps", () => {
    expect(stepBadges({ zukunft: false })).toEqual([
      { key: "zukunft", label: "zukunft aus", variant: "warn" },
    ])
    expect(stepBadges(undefined)).toEqual([])
  })
})
