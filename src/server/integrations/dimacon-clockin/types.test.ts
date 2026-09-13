import { describe, expect, it } from "vitest"
import { DEFAULT_STEPS, SyncRunInputSchema } from "./types.js"

describe("SyncRunInputSchema", () => {
  it("parses {} without steps — scheduler contract", () => {
    const parsed = SyncRunInputSchema.parse({})
    expect(parsed.steps).toBeUndefined()
  })

  it("completes partial steps with true defaults", () => {
    const parsed = SyncRunInputSchema.parse({ steps: { archive: false } })
    expect(parsed.steps).toEqual({
      employees: true,
      customers: true,
      projects: true,
      assignments: true,
      archive: false,
      employeeCreateInDimacon: false,
    })
  })

  it("keeps the dimacon creation switch off by default — scheduler contract", () => {
    // Der Scheduler feuert mit inputSchema.parse({}) → steps bleibt undefined
    // und run.ts nimmt DEFAULT_STEPS; ein Teilobjekt füllt den zod-Default.
    expect(DEFAULT_STEPS.employeeCreateInDimacon).toBe(false)
    expect(SyncRunInputSchema.parse({ steps: {} }).steps?.employeeCreateInDimacon).toBe(false)
    expect(
      SyncRunInputSchema.parse({ steps: { employeeCreateInDimacon: true } }).steps
        ?.employeeCreateInDimacon,
    ).toBe(true)
  })

  it("rejects non-boolean step values", () => {
    const parsed = SyncRunInputSchema.safeParse({ steps: { projects: "yes" } })
    expect(parsed.success).toBe(false)
  })
})
