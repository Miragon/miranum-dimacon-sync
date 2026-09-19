import { describe, expect, it } from "vitest"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import type { LexContact } from "./contact-lookup.js"
import { decideImport, indexDimaconCustomers, looseCompanyKey } from "./import-policy.js"
import type { ImportPolicyInput } from "./import-policy.js"

function contact(overrides: Partial<LexContact> = {}): LexContact {
  return {
    id: "lex-1",
    version: 1,
    roles: { customer: { number: 10010 } },
    company: { name: "Neu Bau GmbH" },
    ...overrides,
  }
}

function input(
  customers: DimaconCustomerInfo[] = [],
  overrides: Partial<ImportPolicyInput> = {},
): ImportPolicyInput {
  return {
    claimed: new Set(),
    dimacon: indexDimaconCustomers(customers),
    duplicateCandidateNames: new Set(),
    ...overrides,
  }
}

describe("looseCompanyKey", () => {
  it("ignores legal forms, punctuation and umlaut spellings", () => {
    expect(looseCompanyKey("Müller GmbH")).toBe("mueller")
    expect(looseCompanyKey("Mueller GmbH & Co. KG")).toBe("mueller")
    expect(looseCompanyKey("Bau-Service Huber e.K.")).toBe("bau service huber")
    expect(looseCompanyKey("Café Rüdiger")).toBe("cafe ruediger")
  })

  it("yields no key for a name that is only a legal form", () => {
    expect(looseCompanyKey("GmbH & Co. KG")).toBe("")
  })
})

describe("decideImport", () => {
  it("creates an unknown contact with the lexware number as dimacon customer number", () => {
    const decision = decideImport(contact(), input())
    expect(decision).toEqual({ kind: "create", name: "Neu Bau GmbH", customerNumber: "10010" })
  })

  it("treats a contact claimed by the forward pass as linked", () => {
    // dry-run bzw. Namensstufe: der Dimacon-Kunde trägt die Nummer noch nicht
    const decision = decideImport(
      contact(),
      input([{ id: "d-1", name: "Neu Bau GmbH", customerNumber: "K-7" }], {
        claimed: new Set(["lex-1"]),
      }),
    )
    expect(decision).toEqual({ kind: "linked" })
  })

  it("treats a dimacon customer with the same number and name as linked", () => {
    const decision = decideImport(
      contact(),
      input([{ id: "d-1", name: "neu bau  gmbh", customerNumber: " 10010 " }]),
    )
    expect(decision).toEqual({ kind: "linked" })
  })

  it("refuses when the number is taken by a differently named dimacon customer", () => {
    const decision = decideImport(
      contact(),
      input([{ id: "d-1", name: "Ganz Anders AG", customerNumber: "10010" }]),
    )
    expect(decision.kind).toBe("skip")
    expect(decision.kind === "skip" && decision.reason).toContain('„Ganz Anders AG" vergeben')
  })

  it("brakes on an exactly named dimacon customer and names the fix", () => {
    const decision = decideImport(
      contact(),
      input([{ id: "d-1", name: "Neu Bau GmbH", customerNumber: "K-7" }]),
    )
    expect(decision.kind).toBe("skip")
    if (decision.kind !== "skip") return
    expect(decision.reason).toContain("Kundennummer K-7")
    expect(decision.reason).toContain("die Kundennummer 10010 eintragen")
  })

  it("brakes on a similarly named dimacon customer (legal form differs)", () => {
    const decision = decideImport(contact(), input([{ id: "d-1", name: "Neu Bau GmbH & Co. KG" }]))
    expect(decision.kind).toBe("skip")
    expect(decision.kind === "skip" && decision.reason).toContain("ohne Kundennummer")
  })

  it("refuses duplicate names among the candidates", () => {
    const decision = decideImport(
      contact(),
      input([], { duplicateCandidateNames: new Set(["neu bau gmbh"]) }),
    )
    expect(decision.kind).toBe("skip")
    expect(decision.kind === "skip" && decision.reason).toContain("nicht eindeutig")
  })

  it.each([
    ["missing", undefined, "nicht gefunden"],
    ["archived", contact({ archived: true }), "archiviert"],
    ["vendor only", contact({ roles: { vendor: { number: 70001 } } }), "keine Kundenrolle"],
    ["without number", contact({ roles: { customer: {} } }), "ohne Kundennummer"],
    ["without name", contact({ company: undefined }), "ohne Namen"],
  ])("skips a contact that is %s", (_label, lexContact, reason) => {
    const decision = decideImport(lexContact, input())
    expect(decision.kind).toBe("skip")
    expect(decision.kind === "skip" && decision.reason).toContain(reason)
  })

  it("uses the person name for private contacts", () => {
    const decision = decideImport(
      contact({ company: undefined, person: { firstName: "Max", lastName: "Muster" } }),
      input(),
    )
    expect(decision.kind === "create" && decision.name).toBe("Max Muster")
  })
})
