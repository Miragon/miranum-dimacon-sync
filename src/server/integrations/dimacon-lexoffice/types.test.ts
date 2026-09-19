import { describe, expect, it } from "vitest"
import { CustomerSyncInputSchema } from "./types.js"

describe("CustomerSyncInputSchema", () => {
  it("parses {} without steps — scheduler contract", () => {
    const parsed = CustomerSyncInputSchema.parse({})
    expect(parsed.steps).toBeUndefined()
  })

  it("completes partial steps with the schema defaults", () => {
    const parsed = CustomerSyncInputSchema.parse({ steps: { createContacts: false } })
    expect(parsed.steps).toEqual({
      createContacts: false,
      alignNumbers: true,
      // LOAD-BEARING: der Opt-in darf durch einen fehlenden Key nie „an" werden
      importFromLexware: false,
    })
  })

  it("keeps an explicitly enabled import", () => {
    const parsed = CustomerSyncInputSchema.parse({ steps: { importFromLexware: true } })
    expect(parsed.steps?.importFromLexware).toBe(true)
  })

  it("rejects non-boolean step values", () => {
    const parsed = CustomerSyncInputSchema.safeParse({ steps: { alignNumbers: "yes" } })
    expect(parsed.success).toBe(false)
  })
})
