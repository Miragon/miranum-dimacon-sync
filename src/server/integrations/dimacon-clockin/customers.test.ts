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

interface SearchRow {
  id: number
  company?: string
  identifier?: string
}

/**
 * Clockin-Suche je Scope und Suchwert („byIdentifier:D-100") — alles
 * Unbekannte liefert keine Treffer. `lastPage` simuliert mehrseitige Antworten.
 */
function routeSearch(routes: Record<string, SearchRow[]>, lastPage: Record<string, number> = {}) {
  searchForCustomersMock.mockImplementation(
    async (req: { body: { scopes: { name: string; parameters: string[] }[] } }) => {
      const { name, parameters } = req.body.scopes[0]
      const key = `${name}:${parameters[0]}`
      return { data: routes[key] ?? [], meta: { last_page: lastPage[key] ?? 1 } }
    },
  )
}

/** Gestellte Suchen in Aufrufreihenfolge, im Format von `routeSearch`. */
function searched(): string[] {
  return searchForCustomersMock.mock.calls.map((c) => {
    const scope = (c[0] as { body: { scopes: { name: string; parameters: string[] }[] } }).body
      .scopes[0]
    return `${scope.name}:${scope.parameters[0]}`
  })
}

/** Syncer, dessen Meldungen (Dubletten, Hinweise) in `messages` landen. */
function reportingSyncer(
  messages: string[],
  options: { dryRun?: boolean; matching?: CustomerMatchingContext } = {},
) {
  return new CustomerSyncer(
    stubClient,
    silentLog,
    options.dryRun ?? false,
    true,
    undefined,
    undefined,
    options.matching ?? matching(),
    (m) => messages.push(m),
  )
}

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
    // Die Nummer geht zuerst an den EXAKTEN Scope — ein Treffer genügt
    expect(searched()).toEqual(["byIdentifier:D-100"])
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
    routeSearch({
      "byNameOrNumber:Muster GmbH": [{ id: 7, company: "Muster GmbH", identifier: "D-100" }],
    })
    const syncer = new CustomerSyncer(stubClient, silentLog, false)

    const mapping = await syncer.resolve({ ...customer, customerNumber: "L-200" })

    expect(mapping?.clockinId).toBe(7)
    expect(searched()).toEqual([
      "byIdentifier:L-200",
      "byNameOrNumber:L-200",
      "byNameOrNumber:Muster GmbH",
    ])
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

  it("creates instead of blocking when only several fuzzy hits exist — and says so", async () => {
    // Produktivfall: die Nummer steckt nur IN den Identifiern alter
    // Niederlassungs-Kunden. Früher „nicht eindeutig" — der Kunde blieb
    // dauerhaft unverknüpft und seine Projekte wurden nie angelegt.
    const legacy = Array.from({ length: 7 }, (_, i) => ({
      id: 10 + i,
      company: `Muster GmbH Niederlassung ${i}`,
      identifier: `D-100-${i}`,
    }))
    routeSearch({ "byNameOrNumber:D-100": legacy, "byNameOrNumber:Muster GmbH": legacy })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const messages: string[] = []

    const mapping = await reportingSyncer(messages).resolve(customer)

    expect(mapping?.clockinId).toBe(42)
    expect(createCustomerMock.mock.calls[0][0]).toMatchObject({ body: { identifier: "D-100" } })
    expect(messages).toEqual([
      "Kunde Muster GmbH: in Clockin neu angelegt (Nummer D-100) — 7 ähnliche Clockin-Kunden (IDs 10, 11, 12, 13, 14, …), bitte prüfen, ob einer davon derselbe Kunde ist",
    ])
  })

  it("says 'würde neu angelegt' in dryRun", async () => {
    routeSearch({
      "byNameOrNumber:D-100": [
        { id: 8, company: "Muster Bau GmbH", identifier: "D-1000" },
        { id: 9, company: "Muster Nord GmbH", identifier: "D-1001" },
      ],
    })
    const messages: string[] = []

    const mapping = await reportingSyncer(messages, { dryRun: true }).resolve(customer)

    expect(mapping?.clockinId).toBe(-1)
    expect(messages[0]).toContain("in Clockin würde neu angelegt (Nummer D-100) — 2 ähnliche")
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("blocks and names real duplicates when several clockin customers carry exactly the number", async () => {
    routeSearch({
      "byIdentifier:D-100": [
        { id: 7, company: "Muster GmbH", identifier: "D-100" },
        { id: 8, company: "Muster GmbH (alt)", identifier: "d-100 " },
        // unscharfe Antwort des Scopes — zählt nicht als exakt
        { id: 9, company: "Muster Bau GmbH", identifier: "D-1000" },
      ],
    })
    const messages: string[] = []

    const mapping = await reportingSyncer(messages).resolve(customer)

    expect(mapping).toBeNull()
    expect(messages).toEqual([
      'Kunde Muster GmbH: 2 Clockin-Kunden tragen die Nummer „D-100" (IDs 7, 8) — Dublette in Clockin, bitte dort zusammenführen; weder verknüpft noch angelegt',
    ])
    expect(searched()).toEqual(["byIdentifier:D-100"])
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("does not create when an exact name hit could hide on a later search page", async () => {
    // Ohne Kundennummer gibt es keinen exakten Scope — nur die unscharfe
    // Suche. Ist sie mehrseitig, ist „kein exakter Treffer" nicht belegt.
    routeSearch(
      {
        "byNameOrNumber:Muster GmbH": [
          { id: 8, company: "Muster Bau GmbH", identifier: "D-1000" },
          { id: 9, company: "Muster Nord GmbH", identifier: "D-1001" },
        ],
      },
      { "byNameOrNumber:Muster GmbH": 2 },
    )
    const messages: string[] = []

    const mapping = await reportingSyncer(messages).resolve({
      ...customer,
      customerNumber: undefined,
    })

    expect(mapping).toBeNull()
    expect(messages[0]).toContain("ist nicht vollständig prüfbar")
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("treats a search answer without page info as possibly incomplete", async () => {
    // Fail-closed wie `requireMeta`: ohne meta.last_page ist die Seitenzahl
    // unbekannt — keine Anlage, die eine Dublette sein könnte.
    searchForCustomersMock.mockResolvedValue({
      data: [
        { id: 8, company: "Muster Bau GmbH", identifier: "D-1000" },
        { id: 9, company: "Muster Nord GmbH", identifier: "D-1001" },
      ],
    })
    const messages: string[] = []

    const mapping = await reportingSyncer(messages).resolve({
      ...customer,
      customerNumber: undefined,
    })

    expect(mapping).toBeNull()
    expect(messages[0]).toContain("ist nicht vollständig prüfbar")
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it("keeps customers of another dimacon customer out of the similar list", async () => {
    routeSearch({
      "byNameOrNumber:D-100": [
        { id: 8, company: "Muster Bau GmbH", identifier: "D-1000" },
        { id: 9, company: "Muster Nord GmbH", identifier: "D-100-alt" },
      ],
    })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const messages: string[] = []

    const mapping = await reportingSyncer(messages, {
      matching: matching({ knownCustomerNumbers: new Set(["d-100", "d-1000"]) }),
    }).resolve(customer)

    // Der verbleibende EINE Kandidat wird nicht plötzlich zum Treffer
    expect(mapping?.clockinId).toBe(42)
    expect(messages[0]).toContain("1 ähnliche Clockin-Kunden (IDs 9)")
  })

  it("reports duplicates in the name fallback when two clockin customers share the name", async () => {
    routeSearch({
      "byNameOrNumber:Muster GmbH": [
        { id: 7, company: "Muster GmbH", identifier: "D-100" },
        { id: 8, company: "Muster GmbH", identifier: "D-900" },
      ],
    })
    const messages: string[] = []

    const mapping = await reportingSyncer(messages).resolve({
      ...customer,
      customerNumber: "L-200",
    })

    expect(mapping).toBeNull()
    expect(messages[0]).toContain('2 Clockin-Kunden tragen den Namen „Muster GmbH"')
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

    // nur die beiden Nummern-Suchen, keine Namenssuche
    expect(searched()).toEqual(["byIdentifier:D-100", "byNameOrNumber:D-100"])
    expect(mapping?.clockinId).toBe(42)
    expect(mapping?.number).toBe("D-100")
  })

  it("matches the name fallback against company, not against identifier", async () => {
    // Unterscheidet die beiden Feld-Varianten: genau EIN exakter
    // company-Treffer neben einem unscharfen Nachbarn. Verglichen der Code
    // gegen `identifier`, gäbe es keinen exakten Treffer und die zwei Zeilen
    // wären mehrdeutig — der Kunde bliebe unverknüpft.
    routeSearch({
      "byNameOrNumber:Muster GmbH": [
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
    routeSearch({
      "byNameOrNumber:Erdbau Friedberg GmbH": [
        { id: 7, company: "Erdbau Friedberg GmbH", identifier: "1001" },
      ],
    })
    createCustomerMock.mockResolvedValue({ data: { id: 42 } })
    const messages: string[] = []
    const syncer = reportingSyncer(messages, {
      matching: matching({ knownCustomerNumbers: new Set(["1001", "1002"]) }),
    })

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
    // Der Zwilling ist bekanntermaßen ein ANDERER Kunde — kein Prüf-Hinweis
    expect(messages).toEqual([])
  })

  it("accepts a name hit whose identifier is only an outdated own number", async () => {
    // Gegenprobe: D-100 gehört keinem anderen Dimacon-Kunden — der Fallback
    // muss weiter greifen, sonst legt jeder Lauf Duplikate in Clockin an.
    routeSearch({
      "byNameOrNumber:Muster GmbH": [{ id: 7, company: "Muster GmbH", identifier: "D-100" }],
    })
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

    expect(searched()).toEqual(["byIdentifier:D-100", "byNameOrNumber:D-100"])
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
    expect(ambiguous[0]).toContain('2 Clockin-Kunden tragen die Nummer „D-100"')
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
