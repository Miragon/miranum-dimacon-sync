import { describe, expect, it } from "vitest"
import { SyncRunInputSchema } from "./types.js"

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
    })
  })

  it("rejects non-boolean step values", () => {
    const parsed = SyncRunInputSchema.safeParse({ steps: { projects: "yes" } })
    expect(parsed.success).toBe(false)
  })
})
