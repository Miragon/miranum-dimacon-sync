import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import type { CustomerMatchingContext } from "./customers.js"

const searchForCustomersMock = vi.fn()
const createCustomerMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: { searchForCustomers: searchForCustomersMock, createCustomer: createCustomerMock },
}))

const { CustomerSyncer, OPEN_CUSTOMER_MATCHING } = await import("./customers.js")
const { log } = await import("../../lib/log.js")

/** Gesamtbestands-Wissen für den Namens-Fallback, Default = alles unauffällig. */
function matching(overrides: Partial<CustomerMatchingContext> = {}): CustomerMatchingContext {
  return { ...OPEN_CUSTOMER_MATCHING, ...overrides }
}

const silentLog = log.child({ test: true })
;(silentLog as unknown as { info: () => void }).info = () => {
  /* swallow */
}

const stubClient = {} as never

const customer: DimaconCustomerInfo = {
  id: "cust-1",
  customerNumber: "D-100",
  name: "Muster GmbH",
  street: "Musterweg 1",
  zipCity: "80331 München",
}

beforeEach(() => {
  searchForCustomersMock.mockReset()
  createCustomerMock.mockReset()
})

describe("CustomerSyncer (ohne Lexware)", () => {
  it("maps an existing clockin customer without creating", async () => {
    searchForCustomersMock.mockResolvedValue({
      data: [{ id: 7, company: "Muster GmbH", identifier: "D-100" }],
    })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve(customer)

    expect(mapping).toEqual({
      dimaconId: "cust-1",
      clockinId: 7,
      number: "D-100",
      name: "Muster GmbH",
    })
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("creates with the dimacon customer number as identifier", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve(customer)

    expect(mapping?.clockinId).toBe(42)
    expect(mapping?.number).toBe("D-100")
    expect(createCustomerMock.mock.calls[0][0]).toMatchObject({
      body: { company: "Muster GmbH", identifier: "D-100", zip: "80331", city: "München" },
    })
  })

  it("falls back to a name lookup when the dimacon number changed (no duplicate)", async () => {
    // Szenario: dimacon-lexoffice hat die Dimacon-Nummer D-100 → L-200
    // geändert, der Clockin-Kunde existiert aber noch mit identifier=D-100.
    searchForCustomersMock
      .mockResolvedValueOnce({ data: [] }) // Lookup mit neuer Nummer L-200 → miss
      .mockResolvedValueOnce({ data: [{ id: 7, company: "Muster GmbH", identifier: "D-100" }] })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve({ ...customer, customerNumber: "L-200" })

    expect(mapping?.clockinId).toBe(7)
    expect(searchForCustomersMock).toHaveBeenCalledTimes(2)
    expect(searchForCustomersMock.mock.calls[0][0]).toMatchObject({
      body: { scopes: [{ name: "byNameOrNumber", parameters: ["L-200"] }] },
    })
    expect(searchForCustomersMock.mock.calls[1][0]).toMatchObject({
      body: { scopes: [{ name: "byNameOrNumber", parameters: ["Muster GmbH"] }] },
    })
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("falls back to the dimacon id when no customer number exists", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockResolvedValue({ data: { id: 43 } })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve({ ...customer, customerNumber: undefined })

    expect(mapping?.number).toBe("cust-1")
    expect(createCustomerMock.mock.calls[0][0]).toMatchObject({
      body: { identifier: "cust-1" },
    })
  })

  it("does not create in dryRun mode", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    const syncer = new CustomerSyncer(stubClient, silentLog, true)

    const mapping = await syncer.resolve(customer)

    expect(mapping?.clockinId).toBe(-1)
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("returns null instead of creating when createMissing is off", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    const syncer = new CustomerSyncer(stubClient, silentLog, false, false)

    const mapping = await syncer.resolve(customer)

    expect(mapping).toBeNull()
    expect(createCustomerMock).not.toHaveBeenCalled()
  })
  // --- Mehrdeutigkeit statt stillem data[0] ------------------------------

  it("prefers the exact identifier hit over an additional fuzzy hit", async () => {
    // Regression: die unscharfe byNameOrNumber-Suche liefert D-1000 zuerst —
    // früher gewann still die falsche Zeile (data[0]).
    searchForCustomersMock.mockResolvedValue({
      data: [
        { id: 8, company: "Muster Bau GmbH", identifier: "D-1000" },
        { id: 7, company: "Muster GmbH", identifier: "D-100" },
      ],
    })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve(customer)

    expect(mapping?.clockinId).toBe(7)
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("reports ambiguity instead of guessing when several fuzzy hits remain", async () => {
    searchForCustomersMock.mockResolvedValue({
      data: [
        { id: 8, company: "Muster Bau GmbH", identifier: "D-1000" },
        { id: 9, company: "Muster Nord GmbH", identifier: "D-1001" },
      ],
    })
    const messages: string[] = []
    const syncer = new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      undefined,
      matching(),
      (m) => messages.push(m),
    )

    const mapping = await syncer.resolve(customer)

    expect(mapping).toBeNull()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("2 Clockin-Kandidaten")
    expect(messages[0]).toContain("8, 9")
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("reports ambiguity in the name fallback when two clockin customers share the name", async () => {
    searchForCustomersMock
      .mockResolvedValueOnce({ data: [] }) // Nummern-Lookup → miss
      .mockResolvedValueOnce({
        data: [
          { id: 7, company: "Muster GmbH", identifier: "D-100" },
          { id: 8, company: "Muster GmbH", identifier: "D-900" },
        ],
      })
    const messages: string[] = []
    const syncer = new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      undefined,
      matching(),
      (m) => messages.push(m),
    )

    const mapping = await syncer.resolve({ ...customer, customerNumber: "L-200" })

    expect(mapping).toBeNull()
    expect(messages[0]).toContain("Muster GmbH")
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("still accepts a single fuzzy hit (no new duplicates in clockin)", async () => {
    searchForCustomersMock.mockResolvedValue({
      data: [{ id: 7, company: "Muster GmbH e.K.", identifier: "D-100-alt" }],
    })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve(customer)

    expect(mapping?.clockinId).toBe(7)
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("skips the name fallback for duplicate dimacon customer names", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const syncer = new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      undefined,
      matching({ duplicateNames: new Set(["muster gmbh"]) }),
    )

    const mapping = await syncer.resolve(customer)

    expect(searchForCustomersMock).toHaveBeenCalledTimes(1)
    expect(mapping?.clockinId).toBe(42)
    expect(mapping?.number).toBe("D-100")
  })

  it("matches the name fallback against company, not against identifier", async () => {
    // Unterscheidet die beiden Feld-Varianten: genau EIN exakter
    // company-Treffer neben einem unscharfen Nachbarn. Verglichen der Code
    // gegen `identifier`, gäbe es keinen exakten Treffer und die zwei Zeilen
    // wären mehrdeutig — der Kunde bliebe unverknüpft.
    searchForCustomersMock
      .mockResolvedValueOnce({ data: [] }) // Nummern-Lookup L-200 → miss
      .mockResolvedValueOnce({
        data: [
          { id: 7, company: "Muster GmbH", identifier: "D-100" },
          { id: 8, company: "Muster GmbH Nord", identifier: "D-900" },
        ],
      })
    const messages: string[] = []
    const syncer = new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      undefined,
      matching({ knownCustomerNumbers: new Set(["l-200"]) }),
      (m) => messages.push(m),
    )

    const mapping = await syncer.resolve({ ...customer, customerNumber: "L-200" })

    expect(mapping?.clockinId).toBe(7)
    expect(messages).toEqual([])
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("rejects a name hit whose identifier is another dimacon customer number", async () => {
    // Gleichnamige Dimacon-Kunden 1001/1002: der Namenstreffer gehört dem
    // Zwilling. Verknüpfen würde alle Zeiten dauerhaft auf ihn buchen.
    searchForCustomersMock
      .mockResolvedValueOnce({ data: [] }) // Nummern-Lookup 1002 → miss
      .mockResolvedValueOnce({
        data: [{ id: 7, company: "Erdbau Friedberg GmbH", identifier: "1001" }],
      })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const syncer = new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      undefined,
      matching({ knownCustomerNumbers: new Set(["1001", "1002"]) }),
    )

    const mapping = await syncer.resolve({
      ...customer,
      id: "cust-2",
      customerNumber: "1002",
      name: "Erdbau Friedberg GmbH",
    })

    expect(mapping?.clockinId).toBe(42)
    expect(createCustomerMock.mock.calls[0][0]).toMatchObject({
      body: { company: "Erdbau Friedberg GmbH", identifier: "1002" },
    })
  })

  it("accepts a name hit whose identifier is only an outdated own number", async () => {
    // Gegenprobe: D-100 gehört keinem anderen Dimacon-Kunden — der Fallback
    // muss weiter greifen, sonst legt jeder Lauf Duplikate in Clockin an.
    searchForCustomersMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: 7, company: "Muster GmbH", identifier: "D-100" }] })
    const syncer = new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      undefined,
      matching({ knownCustomerNumbers: new Set(["l-200"]) }),
    )

    const mapping = await syncer.resolve({ ...customer, customerNumber: "L-200" })

    expect(mapping?.clockinId).toBe(7)
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("disables the name fallback when the dimacon inventory could not be loaded", async () => {
    // Fail-closed: ohne Gesamtbestand ist kein Namenstreffer absicherbar.
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const syncer = new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      undefined,
      matching({ inventoryLoaded: false }),
    )

    const mapping = await syncer.resolve(customer)

    expect(searchForCustomersMock).toHaveBeenCalledTimes(1)
    expect(mapping?.clockinId).toBe(42)
  })
})
