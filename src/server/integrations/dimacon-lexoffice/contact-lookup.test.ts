import { describe, expect, it, vi } from "vitest"
import {
  contactName,
  contactNumber,
  LexofficeContactLookup,
  numericLexwareNumber,
} from "./contact-lookup.js"

function lexClient(content: unknown[]) {
  return { get: vi.fn().mockResolvedValue({ content }) }
}

describe("numericLexwareNumber", () => {
  it("akzeptiert nur rein numerische Werte im Integer-Bereich", () => {
    expect(numericLexwareNumber(" 1001 ")).toBe("1001")
    expect(numericLexwareNumber("K-1001")).toBeUndefined()
    expect(numericLexwareNumber("")).toBeUndefined()
    expect(numericLexwareNumber("  ")).toBeUndefined()
    expect(numericLexwareNumber(undefined)).toBeUndefined()
    expect(numericLexwareNumber("123456789012")).toBeUndefined()
  })
})

describe("contactName", () => {
  it("nimmt den Firmennamen, sonst Vor-/Nachname", () => {
    expect(contactName({ id: "a", version: 0, company: { name: "Muster GmbH" } })).toBe(
      "Muster GmbH",
    )
    expect(
      contactName({ id: "b", version: 0, person: { firstName: "Erika", lastName: "Muster" } }),
    ).toBe("Erika Muster")
    expect(contactName({ id: "c", version: 0 })).toBe("")
  })
})

describe("contactNumber", () => {
  it("normalisiert Zahl und String auf einen getrimmten String", () => {
    expect(contactNumber({ id: "a", version: 0, roles: { customer: { number: 1001 } } })).toBe(
      "1001",
    )
    expect(contactNumber({ id: "a", version: 0, roles: { customer: { number: " 7 " } } })).toBe("7")
    expect(contactNumber({ id: "a", version: 0 })).toBeUndefined()
  })
})

describe("LexofficeContactLookup.byNumber", () => {
  it("fragt mit number+size an und verwirft Treffer mit abweichender Nummer", async () => {
    const client = lexClient([
      { id: "lex-1", version: 1, roles: { customer: { number: "1001" } } },
      { id: "lex-2", version: 1, roles: { customer: { number: "999" } } },
    ])
    const lookup = new LexofficeContactLookup(client as never)

    const hits = await lookup.byNumber("1001")

    expect(client.get).toHaveBeenCalledWith("/v1/contacts", { number: "1001", size: "250" })
    expect(hits.map((c) => c.id)).toEqual(["lex-1"])
  })

  it("verwirft archivierte Kontakte", async () => {
    const client = lexClient([
      { id: "lex-1", version: 1, roles: { customer: { number: "1001" } }, archived: true },
    ])
    const lookup = new LexofficeContactLookup(client as never)

    expect(await lookup.byNumber("1001")).toEqual([])
  })

  it("vergleicht eine als JSON-Zahl gelieferte Kundennummer korrekt", async () => {
    const client = lexClient([{ id: "lex-1", version: 1, roles: { customer: { number: 1001 } } }])
    const lookup = new LexofficeContactLookup(client as never)

    const hits = await lookup.byNumber("1001")

    expect(hits.map((c) => c.id)).toEqual(["lex-1"])
  })
})

describe("LexofficeContactLookup.byName", () => {
  const asCustomer = { customer: {} }

  it("liefert alle exakten Treffer und verwirft Substring-Treffer", async () => {
    const client = lexClient([
      { id: "lex-1", version: 1, roles: asCustomer, company: { name: "Muster GmbH" } },
      { id: "lex-2", version: 1, roles: asCustomer, company: { name: "muster   gmbh" } },
      { id: "lex-3", version: 1, roles: asCustomer, company: { name: "Muster GmbH & Co. KG" } },
    ])
    const lookup = new LexofficeContactLookup(client as never)

    const hits = await lookup.byName("Muster GmbH")

    // customer=true hält reine Lieferanten schon serverseitig heraus
    expect(client.get).toHaveBeenCalledWith("/v1/contacts", {
      name: "Muster GmbH",
      customer: "true",
      size: "250",
    })
    expect(hits.map((c) => c.id)).toEqual(["lex-1", "lex-2"])
  })

  it("verwirft einen reinen Lieferanten-Kontakt gleichen Namens", async () => {
    // Sonst gälte er als Treffer und blockierte die Anlage des
    // Kunden-Kontakts still (er trägt nie eine Kundennummer).
    const client = lexClient([
      {
        id: "lex-vendor",
        version: 1,
        roles: { vendor: { number: 70001 } },
        company: { name: "Haufe Service Center GmbH" },
      },
    ])
    const lookup = new LexofficeContactLookup(client as never)

    expect(await lookup.byName("Haufe Service Center GmbH")).toEqual([])
  })

  it("verwirft archivierte Kontakte", async () => {
    const client = lexClient([
      {
        id: "lex-1",
        version: 1,
        roles: asCustomer,
        company: { name: "Muster GmbH" },
        archived: true,
      },
    ])
    const lookup = new LexofficeContactLookup(client as never)

    expect(await lookup.byName("Muster GmbH")).toEqual([])
  })

  it("findet einen als Privatperson angelegten Kontakt", async () => {
    // Stufe 1 plausibilisiert über contactName (Firma ODER Person) — Stufe 2
    // muss dieselbe Namensdefinition benutzen, sonst entsteht ein Duplikat.
    const client = lexClient([
      {
        id: "lex-person",
        version: 1,
        roles: asCustomer,
        person: { firstName: "Erika", lastName: "Muster" },
      },
    ])
    const lookup = new LexofficeContactLookup(client as never)

    const hits = await lookup.byName("Erika Muster")

    expect(hits.map((c) => c.id)).toEqual(["lex-person"])
  })

  it("liefert eine leere Liste, wenn die Antwort kein content-Feld hat", async () => {
    const client = { get: vi.fn().mockResolvedValue({}) }
    const lookup = new LexofficeContactLookup(client as never)

    expect(await lookup.byName("Muster GmbH")).toEqual([])
  })
})
