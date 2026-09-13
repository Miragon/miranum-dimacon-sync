import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"

const updateCustomerMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: { updateCustomer: updateCustomerMock },
}))

const { CustomerAligner } = await import("./aligner.js")
const { LexwareContactIndex } = await import("./contact-index.js")
const { log } = await import("../../lib/log.js")

const silentLog = log.child({ test: true })
;(silentLog as unknown as { info: () => void }).info = () => {
  /* swallow */
}

const dimaconClient = {} as never

const customer: DimaconCustomerInfo = {
  id: "cust-1",
  customerNumber: "D-100",
  name: "Muster GmbH",
  street: "Musterweg 1",
  zipCity: "80331 München",
}

function lexClient(overrides: { get?: unknown; post?: unknown } = {}) {
  return {
    get: vi.fn().mockResolvedValue({ content: [] }),
    post: vi.fn().mockResolvedValue({ id: "lex-new", version: 0 }),
    ...overrides,
  }
}

beforeEach(() => {
  updateCustomerMock.mockReset()
  updateCustomerMock.mockResolvedValue({})
})

describe("CustomerAligner", () => {
  it("returns unchanged when the lexware number already matches", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "D-100" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(customer)

    expect(row.status).toBe("unchanged")
    expect(row.lexwareContactId).toBe("lex-1")
    expect(lex.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("aligns the dimacon number when the lexware number differs", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(customer)

    expect(row.status).toBe("aligned")
    expect(row.lexwareNumber).toBe("L-200")
    expect(updateCustomerMock).toHaveBeenCalledTimes(1)
    expect(updateCustomerMock.mock.calls[0][0]).toMatchObject({
      path: { customerId: "cust-1" },
      body: { name: "Muster GmbH", customerNumber: "L-200" },
    })
  })

  it("echoes custom attribute values and description on the alignment write-back", async () => {
    // Regression: das Dimacon-PUT ist ein Voll-Replace — ein leeres
    // customAttributeValues-Array hat die Attributwerte gelöscht.
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    await aligner.align({
      ...customer,
      description: "wichtiger Kunde",
      customAttributeValues: [{ attributeId: "attr-1", value: "42" }],
    })

    expect(updateCustomerMock.mock.calls[0][0].body).toMatchObject({
      description: "wichtiger Kunde",
      customAttributeValues: [{ attributeId: "attr-1", value: "42" }],
    })
  })

  it("skips creation when the createContacts step is off", async () => {
    const lex = lexClient()
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false, {
      createContacts: false,
      alignNumbers: true,
    })

    const row = await aligner.align(customer)

    expect(row.status).toBe("skipped")
    expect(lex.post).not.toHaveBeenCalled()
  })

  it("skips number alignment when the alignNumbers step is off", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false, {
      createContacts: true,
      alignNumbers: false,
    })

    const row = await aligner.align(customer)

    expect(row.status).toBe("unchanged")
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("does not align when the dimacon customer has no number", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align({ ...customer, customerNumber: undefined })

    expect(row.status).toBe("unchanged")
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("creates a lexware contact when none matches by name", async () => {
    const lex = lexClient()
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(customer)

    expect(row.status).toBe("created")
    expect(row.lexwareContactId).toBe("lex-new")
    expect(lex.post).toHaveBeenCalledTimes(1)
    // Default-Zuordnung reproduziert den bisherigen hartkodierten Body
    expect((lex.post as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      version: 0,
      roles: { customer: {} },
      company: { name: "Muster GmbH" },
      addresses: {
        billing: [
          {
            supplement: undefined,
            street: "Musterweg 1",
            zip: "80331",
            city: "München",
            countryCode: "DE",
          },
        ],
      },
    })
    // Create-Response enthält keine roles → kein Alignment in diesem Lauf
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("performs no writes in dryRun mode", async () => {
    const lexMissing = lexClient()
    const alignerMissing = new CustomerAligner(dimaconClient, lexMissing as never, silentLog, true)
    const created = await alignerMissing.align(customer)
    expect(created.status).toBe("created")
    expect(lexMissing.post).not.toHaveBeenCalled()

    const lexDiffers = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const alignerDiffers = new CustomerAligner(dimaconClient, lexDiffers as never, silentLog, true)
    const aligned = await alignerDiffers.align(customer)
    expect(aligned.status).toBe("aligned")
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  // --- Mehrstufige Auflösung (Nummer vor Name) ---------------------------

  const numbered: DimaconCustomerInfo = { ...customer, customerNumber: "1001" }

  it("resolves via the customer number without ever asking by name", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "1001" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(numbered)

    expect(row.status).toBe("unchanged")
    expect(row.lexwareContactId).toBe("lex-1")
    expect(lex.get).toHaveBeenCalledTimes(1)
    expect(lex.get).toHaveBeenCalledWith("/v1/contacts", { number: "1001", size: "250" })
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("reports a conflict when the number hits a foreign contact and no name matches", async () => {
    const lex = lexClient({
      get: vi.fn(async (_path: string, params: Record<string, string>) =>
        params.number
          ? {
              content: [
                {
                  id: "lex-9",
                  version: 1,
                  company: { name: "Fremd AG" },
                  roles: { customer: { number: "1001" } },
                },
              ],
            }
          : { content: [] },
      ),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(numbered)

    expect(row.status).toBe("conflict")
    expect(row.reason).toContain("1001")
    expect(row.reason).toContain("Fremd AG")
    expect(row.reason).toContain("lex-9")
    expect(lex.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("falls through to the name lookup when the number hit is implausible", async () => {
    const lex = lexClient({
      get: vi.fn(async (_path: string, params: Record<string, string>) =>
        params.number
          ? {
              content: [
                {
                  id: "lex-9",
                  version: 1,
                  company: { name: "Fremd AG" },
                  roles: { customer: { number: "1001" } },
                },
              ],
            }
          : {
              content: [
                {
                  id: "lex-1",
                  version: 1,
                  company: { name: "Muster GmbH" },
                  roles: { customer: { number: "L-200" } },
                },
              ],
            },
      ),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(numbered)

    expect(row.status).toBe("aligned")
    expect(row.lexwareContactId).toBe("lex-1")
    expect(row.reason).toContain("1001 → L-200")
    expect(row.reason).toContain("Fremd AG")
    expect(updateCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("reports ambiguity when two lexware contacts share the company name", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
          {
            id: "lex-2",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-300" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(customer)

    expect(row.status).toBe("ambiguous")
    expect(row.reason).toContain("2 Lexware-Kontakte")
    expect(row.reason).toContain("lex-1")
    expect(row.reason).toContain("lex-2")
    expect(lex.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("never writes for duplicate dimacon customer names (same number / duplicate contact)", async () => {
    // (a) Lexware-Kontakt existiert: beide gleichnamigen Dimacon-Kunden
    //     bekämen sonst dieselbe Lexware-Nummer geschrieben.
    const lexExisting = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "L-200" } },
          },
        ],
      }),
    })
    const alignerExisting = new CustomerAligner(
      dimaconClient,
      lexExisting as never,
      silentLog,
      false,
      undefined,
      undefined,
      undefined,
      { names: new Set(["muster gmbh"]), numbers: new Set() },
    )

    const existingRow = await alignerExisting.align(customer)

    expect(existingRow.status).toBe("ambiguous")
    expect(existingRow.reason).toContain("gleichen Namens")
    expect(updateCustomerMock).not.toHaveBeenCalled()

    // (b) Kein Lexware-Kontakt: sonst legen beide parallel einen an.
    const lexMissing = lexClient()
    const alignerMissing = new CustomerAligner(
      dimaconClient,
      lexMissing as never,
      silentLog,
      false,
      undefined,
      undefined,
      undefined,
      { names: new Set(["muster gmbh"]), numbers: new Set() },
    )

    const missingRow = await alignerMissing.align(customer)

    expect(missingRow.status).toBe("ambiguous")
    expect(lexMissing.post).not.toHaveBeenCalled()
  })

  it("skips the number stage when the dimacon number is used more than once", async () => {
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "1001" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(
      dimaconClient,
      lex as never,
      silentLog,
      false,
      undefined,
      undefined,
      undefined,
      { names: new Set(), numbers: new Set(["1001"]) },
    )

    const row = await aligner.align(numbered)

    expect(row.status).toBe("unchanged")
    expect(lex.get).toHaveBeenCalledTimes(1)
    expect(lex.get).toHaveBeenCalledWith("/v1/contacts", {
      name: "Muster GmbH",
      customer: "true",
      size: "250",
    })
  })

  it("keeps the duplicate-name gate BEHIND the number stage", async () => {
    // Der Grund der Duplikat-Meldung verspricht „Auflösung nur über die
    // Kundennummer möglich" — genau diese Reihenfolge wird hier festgenagelt.
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-1",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { customer: { number: "1001" } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(
      dimaconClient,
      lex as never,
      silentLog,
      false,
      undefined,
      undefined,
      undefined,
      { names: new Set(["muster gmbh"]), numbers: new Set() },
    )

    const row = await aligner.align(numbered)

    expect(row.status).toBe("unchanged")
    expect(row.lexwareContactId).toBe("lex-1")
    expect(lex.get).toHaveBeenCalledTimes(1)
    expect(lex.get).toHaveBeenCalledWith("/v1/contacts", { number: "1001", size: "250" })
  })

  it("matches a lexware contact that is stored as a private person", async () => {
    // Stufe 1 kennt Personenkontakte (contactName) — Stufe 2 muss dieselbe
    // Namensdefinition benutzen, sonst legt jeder Lauf ein firmenförmiges
    // Duplikat neben den bestehenden Personenkontakt.
    const lex = lexClient({
      get: vi.fn(async (_path: string, params: Record<string, string>) =>
        params.number
          ? { content: [] }
          : {
              content: [
                {
                  id: "lex-person",
                  version: 1,
                  person: { firstName: "Erika", lastName: "Muster" },
                  roles: { customer: { number: "10500" } },
                },
              ],
            },
      ),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align({ ...numbered, name: "Erika Muster" })

    expect(row.status).toBe("aligned")
    expect(row.lexwareContactId).toBe("lex-person")
    expect(lex.post).not.toHaveBeenCalled()
  })

  it("ignores a vendor-only contact of the same name and creates the customer", async () => {
    // Ein reiner Lieferanten-Kontakt darf die Anlage des Kunden-Kontakts
    // nicht still blockieren (er trüge nie eine Kundennummer).
    const lex = lexClient({
      get: vi.fn().mockResolvedValue({
        content: [
          {
            id: "lex-vendor",
            version: 1,
            company: { name: "Muster GmbH" },
            roles: { vendor: { number: 70001 } },
          },
        ],
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(customer)

    expect(row.status).toBe("created")
    expect(row.lexwareContactId).toBe("lex-new")
    expect(lex.post).toHaveBeenCalledTimes(1)
  })

  it("falls back to the name lookup when the number lookup fails", async () => {
    const lex = lexClient({
      get: vi.fn(async (_path: string, params: Record<string, string>) => {
        // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
        if (params.number) throw new Error("boom 400")
        return {
          content: [
            {
              id: "lex-1",
              version: 1,
              company: { name: "Muster GmbH" },
              roles: { customer: { number: "L-200" } },
            },
          ],
        }
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(numbered)

    expect(row.status).toBe("aligned")
    expect(row.lexwareNumber).toBe("L-200")
    expect(updateCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("never creates a contact when the number lookup failed and no name matches", async () => {
    // Fail-closed: der Kontakt könnte in Lexware unter der Nummer liegen und
    // nur umbenannt worden sein — anlegen erzeugte ein Duplikat.
    const lex = lexClient({
      get: vi.fn(async (_path: string, params: Record<string, string>) => {
        // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
        if (params.number) throw new Error("boom 400")
        return { content: [] }
      }),
    })
    const aligner = new CustomerAligner(dimaconClient, lex as never, silentLog, false)

    const row = await aligner.align(numbered)

    expect(row.status).toBe("conflict")
    expect(row.reason).toContain("Nummernsuche")
    expect(row.reason).toContain("1001")
    expect(lex.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })
})

describe("CustomerAligner mit Lexware-Kontaktindex (#15)", () => {
  const lexContact = (id: string, name: string, number?: string) => ({
    id,
    version: 1,
    company: { name },
    roles: { customer: number === undefined ? {} : { number } },
  })

  function indexedAligner(
    contacts: Parameters<typeof LexwareContactIndex.prototype.add>[0][],
    lex = lexClient(),
  ) {
    const index = new LexwareContactIndex(contacts)
    return {
      lex,
      index,
      aligner: new CustomerAligner(
        dimaconClient,
        lex as never,
        silentLog,
        false,
        { createContacts: true, alignNumbers: true },
        undefined,
        () => undefined,
        { names: new Set(), numbers: new Set() },
        index,
      ),
    }
  }

  it("löst über die Nummer auf, ohne einen einzigen GET", async () => {
    const { aligner, lex } = indexedAligner([lexContact("lex-1", "Muster GmbH", "D-100")])

    const row = await aligner.align(customer)

    expect(row.status).toBe("unchanged")
    expect(row.lexwareContactId).toBe("lex-1")
    expect(lex.get).not.toHaveBeenCalled()
  })

  it("löst über den Namen auf, ohne einen einzigen GET", async () => {
    // D-100 ist nicht numerisch ⇒ die Nummernstufe entfällt wie bisher.
    const { aligner, lex } = indexedAligner([lexContact("lex-1", "Muster GmbH", "9999")])

    const row = await aligner.align(customer)

    expect(row.lexwareContactId).toBe("lex-1")
    expect(row.status).toBe("aligned")
    expect(lex.get).not.toHaveBeenCalled()
  })

  it("meldet gleichnamige Kontakte als mehrdeutig statt zu schreiben", async () => {
    // Mit einem EINWERTIGEN Index wäre dieser Schutz still weg.
    const { aligner, lex } = indexedAligner([
      lexContact("lex-1", "Muster GmbH", "1"),
      lexContact("lex-2", "Muster GmbH", "2"),
    ])

    const row = await aligner.align(customer)

    expect(row.status).toBe("ambiguous")
    expect(row.reason).toContain("gleichem Firmennamen")
    expect(lex.post).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("macht einen frisch angelegten Kontakt sofort auffindbar (kein zweiter POST)", async () => {
    const { aligner, lex } = indexedAligner([])

    const first = await aligner.align({ ...customer, customerNumber: "D-1" })
    const second = await aligner.align({ ...customer, id: "cust-2", customerNumber: "D-2" })

    expect(first.status).toBe("created")
    expect(second.status).toBe("unchanged")
    expect(second.lexwareContactId).toBe("lex-new")
    expect(lex.post).toHaveBeenCalledTimes(1)
  })
})
