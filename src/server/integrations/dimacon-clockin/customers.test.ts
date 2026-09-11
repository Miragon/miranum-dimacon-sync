import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import type { CustomerMatchingContext } from "./customers.js"

const searchForCustomersMock = vi.fn()
const createCustomerMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: { searchForCustomers: searchForCustomersMock, createCustomer: createCustomerMock },
}))

const { CustomerSyncer, OPEN_CUSTOMER_MATCHING } = await import("./customers.js")
const { buildIndex } = await import("./customer-index.js")
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

describe("CustomerSyncer — Anlage ist nicht idempotent", () => {
  /**
   * LOAD-BEARING: der Error-Interceptor hängt inzwischen `status` an den
   * Fehler, wodurch `isTransient` einen 5xx erkennt. Ohne
   * NON_IDEMPOTENT_RETRY würde der POST bis zu 5-mal abgesetzt — bei einem
   * 5xx NACH dem Insert stünden am Ende bis zu 5 Kunden in Clockin.
   */
  it("setzt den POST bei einem 5xx genau einmal ab", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockRejectedValue({ message: "Server Error", status: 500 })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    await expect(syncer.resolve(customer)).rejects.toMatchObject({ status: 500 })
    expect(createCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("setzt den POST bei einem Verbindungsabbruch genau einmal ab", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
    )
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    await expect(syncer.resolve(customer)).rejects.toThrow("fetch failed")
    expect(createCustomerMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * Regressionsschutz für die Verdrahtung von NON_IDEMPOTENT_RETRY: Die
 * Kunden-Anlage darf nach einem 5xx NICHT wiederholt werden — der Insert
 * kann serverseitig bereits durchgelaufen sein und der Retry legt eine
 * Dublette an. Ohne diesen Test bleibt ein Entfernen der Retry-Option stumm.
 */
describe("Retry-Verhalten der Kunden-Anlage", () => {
  it("wiederholt createCustomer nach einem 5xx NICHT", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockRejectedValue(Object.assign(new Error("Server Error"), { status: 500 }))
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    await expect(syncer.resolve(customer)).rejects.toThrow()

    expect(createCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("wiederholt createCustomer bei einem Rate-Limit sehr wohl", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock
      .mockRejectedValueOnce(Object.assign(new Error("Too Many Attempts"), { status: 429 }))
      .mockResolvedValue({ data: { id: 99 } })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve(customer)

    expect(mapping?.clockinId).toBe(99)
    expect(createCustomerMock).toHaveBeenCalledTimes(2)
  }, 60_000)
})

/** Syncer mit vorab geladenem Clockin-Kundenindex (#15). */
function indexedSyncer(rows: Parameters<typeof buildIndex>[0]) {
  const index = buildIndex(rows)
  return {
    index,
    syncer: new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      () => undefined,
      matching(),
      () => undefined,
      index,
    ),
  }
}

describe("CustomerSyncer mit Clockin-Kundenindex (#15)", () => {
  it("löst über die Nummer auf, ohne einen einzigen searchForCustomers-Aufruf", async () => {
    const { syncer } = indexedSyncer([{ id: 7, company: "Muster GmbH", identifier: "D-100" }])

    const mapping = await syncer.resolve(customer)

    expect(mapping?.clockinId).toBe(7)
    expect(searchForCustomersMock).not.toHaveBeenCalled()
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("bedient den Namens-Fallback lokal (geänderte Dimacon-Nummer)", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    const { syncer } = indexedSyncer([{ id: 7, company: "Muster GmbH", identifier: "D-100" }])

    const mapping = await syncer.resolve({ ...customer, customerNumber: "L-200" })

    expect(mapping?.clockinId).toBe(7)
    // Nur die Nummernstufe ging (als Miss) an den Server, der Name kam lokal
    expect(searchForCustomersMock).toHaveBeenCalledTimes(1)
    expect(searchForCustomersMock.mock.calls[0][0]).toMatchObject({
      body: { scopes: [{ name: "byNameOrNumber", parameters: ["L-200"] }] },
    })
  })

  it("meldet mehrere exakte Treffer als mehrdeutig statt zu schreiben (#16 bleibt scharf)", async () => {
    // Genau der Fall, den ein EINWERTIGER Index still verschlucken würde.
    const ambiguous: string[] = []
    const index = buildIndex([
      { id: 7, company: "Muster GmbH", identifier: "D-100" },
      { id: 8, company: "Muster GmbH", identifier: "D-100" },
    ])
    const syncer = new CustomerSyncer(
      stubClient,
      silentLog,
      false,
      true,
      undefined,
      () => undefined,
      matching(),
      (message) => void ambiguous.push(message),
      index,
    )

    expect(await syncer.resolve(customer)).toBeNull()
    expect(ambiguous[0]).toContain("2 Clockin-Kandidaten")
    expect(createCustomerMock).not.toHaveBeenCalled()
    expect(searchForCustomersMock).not.toHaveBeenCalled()
  })

  it("fragt bei einem Index-Miss weiterhin die unscharfe Serversuche", async () => {
    // Der Index kennt nur EXAKTE Treffer — ohne diesen Fallback legte der Lauf
    // bisher unscharf gematchte Kunden neu an.
    searchForCustomersMock.mockResolvedValue({
      data: [{ id: 9, company: "Muster GmbH & Co. KG", identifier: "D-100-alt" }],
    })
    const { syncer } = indexedSyncer([])

    const mapping = await syncer.resolve(customer)

    expect(mapping?.clockinId).toBe(9)
    expect(searchForCustomersMock).toHaveBeenCalled()
  })

  it("macht einen frisch angelegten Kunden sofort auffindbar (keine Doppelanlage)", async () => {
    searchForCustomersMock.mockResolvedValue({ data: [] })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const { syncer } = indexedSyncer([])

    const first = await syncer.resolve(customer)
    const second = await syncer.resolve({ ...customer, id: "cust-2" })

    expect(first?.clockinId).toBe(42)
    expect(second?.clockinId).toBe(42)
    expect(createCustomerMock).toHaveBeenCalledTimes(1)
  })
})
