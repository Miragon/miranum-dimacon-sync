import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"
import type { DimaconAttributeDef } from "../shared/field-mapping.js"
import type { MappingRule } from "../shared/field-mapping-schema.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import type { IntegrationRunContext } from "../types.js"

const updateCustomerMock = vi.fn()
const createNewCustomerMock = vi.fn()
vi.mock("@miragon/client-dimacon", () => ({
  sdk: { updateCustomer: updateCustomerMock, createNewCustomer: createNewCustomerMock },
}))

const loadAllCustomersMock = vi.fn()
vi.mock("../shared/dimacon.js", () => ({ loadAllCustomers: loadAllCustomersMock }))

const loadMappingContextMock = vi.fn()
vi.mock("../shared/mapping-context.js", () => ({ loadMappingContext: loadMappingContextMock }))

const { runDimaconLexofficeSync } = await import("./run.js")
const { addDays, todayInBerlin } = await import("../shared/time.js")
const { FIELD_CATALOG } = await import("../shared/field-catalog.js")
const { EMPTY_DISCOVERY } = await import("../shared/field-mapping.js")

/**
 * Mapping-Kontext wie aus loadMappingContext: lexofficeContact fehlt (⇒
 * Default-Zuordnung), dimaconCustomer kommt immer mit Discovery.
 */
function mappingServes(
  targetAttributes: DimaconAttributeDef[] = [],
  rules: MappingRule[] = FIELD_CATALOG.dimaconCustomer.defaultRules,
) {
  loadMappingContextMock.mockImplementation(async ({ entities }: { entities: string[] }) =>
    entities.includes("dimaconCustomer")
      ? new Map([
          [
            "dimaconCustomer",
            {
              entity: "dimaconCustomer",
              rules,
              catalog: FIELD_CATALOG.dimaconCustomer,
              discovery: { ...EMPTY_DISCOVERY, targetAttributes },
              isCustomized: false,
              hasCustomTargets: false,
            },
          ],
        ])
      : new Map(),
  )
}

const noop = () => {
  /* swallow */
}
const silentLog: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => silentLog,
}

const lexGet = vi.fn()
const lexPost = vi.fn()

function testCtx(): IntegrationRunContext {
  return {
    tenantId: "tenant-test",
    trigger: "manual",
    clients: {
      tenantId: "tenant-test",
      clockin: async () => ({ kind: "clockin" }) as never,
      dimacon: async () => ({ kind: "dimacon" }) as never,
      lexoffice: async () => ({ get: lexGet, post: lexPost }) as never,
      sevdesk: async () => ({ kind: "sevdesk" }) as never,
    },
    getFieldMapping: async () => undefined,
    log: silentLog,
  }
}

function customer(overrides: Partial<DimaconCustomerInfo>): DimaconCustomerInfo {
  return { id: "cust-x", name: "Muster GmbH", ...overrides }
}

/** Die Needles aller Lexware-Suchen dieses Laufs. */
function lexQueries(): Record<string, string>[] {
  return lexGet.mock.calls.map((call) => call[1] as Record<string, string>)
}

/** Die eine Seite des Kontakt-Voll-Imports (#15) — kein Request je Kunde. */
const INDEX_PAGE = { page: "0", size: "250" }

/** Suchen JE KUNDE — der Voll-Import zählt bewusst nicht mit. */
function perCustomerQueries(): Record<string, string>[] {
  return lexQueries().filter((q) => q.page === undefined)
}

function rowFor(
  result: Awaited<ReturnType<typeof runDimaconLexofficeSync>>,
  dimaconCustomerId: string,
) {
  const row = result.customers.find((r) => r.dimaconCustomerId === dimaconCustomerId)
  if (!row) throw new Error(`keine Ergebniszeile für ${dimaconCustomerId}`)
  return row
}

/** Lexware-Antworten je Endpunkt: Kontakt-Voll-Import bzw. Belegliste. */
function lexwareServes(data: { contacts?: unknown[]; vouchers?: unknown[] }) {
  lexGet.mockImplementation(async (path: string) =>
    path === "/v1/voucherlist"
      ? { content: data.vouchers ?? [], totalPages: 1, last: true }
      : { content: data.contacts ?? [], last: true },
  )
}

function voucherQueries(): Record<string, string>[] {
  return lexGet.mock.calls
    .filter((call) => call[0] === "/v1/voucherlist")
    .map((call) => call[1] as Record<string, string>)
}

const IMPORT_ON = { createContacts: true, alignNumbers: true, importFromLexware: true }

beforeEach(() => {
  vi.resetAllMocks()
  updateCustomerMock.mockResolvedValue({})
  createNewCustomerMock.mockResolvedValue({ id: "d-new" })
  // Leerer Kontext → run.ts fällt auf die Default-Zuordnung zurück
  mappingServes()
  lexGet.mockResolvedValue({ content: [], last: true })
  lexPost.mockResolvedValue({ id: "lex-new", version: 0 })
})

describe("runDimaconLexofficeSync (Orchestrierung)", () => {
  it("verdrahtet die Namens-Duplikate in die Namensstufe", async () => {
    // Zwei gleichnamige Dimacon-Kunden mit verschiedenen Nummern: ohne den
    // Namens-Gate legten beide parallel je einen Lexware-Kontakt an.
    loadAllCustomersMock.mockResolvedValue([
      customer({ id: "cust-1", customerNumber: "K-1", name: "Muster GmbH" }),
      customer({ id: "cust-2", customerNumber: "K-2", name: "Muster GmbH" }),
    ])

    const result = await runDimaconLexofficeSync(testCtx(), {})

    for (const id of ["cust-1", "cust-2"]) {
      const row = rowFor(result, id)
      expect(row.status).toBe("ambiguous")
      expect(row.reason).toContain("gleichen Namens")
    }
    expect(lexPost).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
    // Namensstufe gesperrt ⇒ keine Suche je Kunde (K-1/K-2 sind nicht numerisch)
    expect(perCustomerQueries()).toEqual([])
    expect(lexQueries()).toEqual([INDEX_PAGE])
  })

  it("verdrahtet die Nummern-Duplikate in die Nummernstufe", async () => {
    // Dieselbe Kundennummer bei verschiedenen Namen: die Nummer ist kein
    // Schlüssel und darf gar nicht erst angefragt werden.
    loadAllCustomersMock.mockResolvedValue([
      customer({ id: "cust-1", customerNumber: "1001", name: "Muster GmbH" }),
      customer({ id: "cust-2", customerNumber: "1001", name: "Fremd AG" }),
    ])

    // Ein Lexware-Kontakt trägt genau diese Nummer, heißt aber anders. Nur wenn
    // die Nummernstufe gesperrt ist, bleibt er unbeachtet — sonst liefert die
    // Nummer diesen fremden Kontakt und beide Kunden enden als `conflict`
    // statt als `created`.
    lexGet.mockResolvedValue({
      content: [
        {
          id: "lex-fremd",
          version: 1,
          company: { name: "Nummern-Zwilling GmbH" },
          roles: { customer: { number: "1001" } },
        },
      ],
      last: true,
    })

    const result = await runDimaconLexofficeSync(testCtx(), {})

    // Aufgelöst wird komplett aus dem Voll-Index — kein Request je Kunde.
    // (Die Nummernstufe liefe lokal, sie ist an den Requests NICHT ablesbar —
    // gesperrt ist sie allein am Status unten erkennbar.)
    expect(lexQueries()).toEqual([INDEX_PAGE])
    // Nummer gesperrt, Namen eindeutig ⇒ beide werden normal angelegt
    expect(rowFor(result, "cust-1").status).toBe("created")
    expect(rowFor(result, "cust-2").status).toBe("created")
    expect(lexPost).toHaveBeenCalledTimes(2)
  })

  it("nutzt die Nummernstufe für eindeutige numerische Kundennummern", async () => {
    // Gegenprobe zu den beiden Sperren: ohne Duplikat gewinnt die Nummer.
    loadAllCustomersMock.mockResolvedValue([
      customer({ id: "cust-1", customerNumber: "1001", name: "Muster GmbH" }),
    ])
    lexGet.mockResolvedValue({
      content: [
        {
          id: "lex-1",
          version: 1,
          company: { name: "Muster GmbH" },
          roles: { customer: { number: "1001" } },
        },
      ],
      last: true,
    })

    const result = await runDimaconLexofficeSync(testCtx(), {})

    // Auflösung über die Nummer — aber lokal aus dem Voll-Index.
    expect(lexQueries()).toEqual([INDEX_PAGE])
    expect(rowFor(result, "cust-1").status).toBe("unchanged")
    expect(lexPost).not.toHaveBeenCalled()
  })

  it("fällt auf die Suche je Kunde zurück, wenn der Kontakt-Voll-Import scheitert", async () => {
    loadAllCustomersMock.mockResolvedValue([
      customer({ id: "cust-1", customerNumber: "1001", name: "Muster GmbH" }),
    ])
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    lexGet.mockRejectedValueOnce(new Error("boom 400"))
    lexGet.mockResolvedValue({
      content: [
        {
          id: "lex-1",
          version: 1,
          company: { name: "Muster GmbH" },
          roles: { customer: { number: "1001" } },
        },
      ],
      last: true,
    })

    const result = await runDimaconLexofficeSync(testCtx(), {})

    // Optimierung aus, Fachlogik unverändert: Nummernsuche je Kunde
    expect(perCustomerQueries()).toEqual([{ number: "1001", size: "250" }])
    expect(rowFor(result, "cust-1").status).toBe("unchanged")
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "customers",
        message: expect.stringContaining("nicht vorab geladen"),
      }),
    )
    expect(lexPost).not.toHaveBeenCalled()
  })

  it("meldet einen Ladefehler des Kundenbestands ohne Schreibvorgang", async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    loadAllCustomersMock.mockRejectedValue(new Error("boom 400"))

    const result = await runDimaconLexofficeSync(testCtx(), {})

    expect(result.customers).toEqual([])
    expect(result.errors).toContainEqual(expect.objectContaining({ scope: "customers" }))
    expect(lexPost).not.toHaveBeenCalled()
  })
})

describe("runDimaconLexofficeSync (Übernahme Lexware → Dimacon)", () => {
  const altContact = {
    id: "lex-alt",
    version: 1,
    company: { name: "Alt GmbH" },
    roles: { customer: { number: 10001 } },
  }
  const neuContact = {
    id: "lex-neu",
    version: 1,
    company: { name: "Neu GmbH" },
    roles: { customer: { number: 10010 } },
    addresses: { billing: [{ street: "Weg 1", zip: "80331", city: "München" }] },
  }

  it("fragt ohne eingeschalteten Schritt keine Belege ab", async () => {
    loadAllCustomersMock.mockResolvedValue([customer({ id: "cust-1" })])

    const result = await runDimaconLexofficeSync(testCtx(), {})

    expect(voucherQueries()).toEqual([])
    expect(result.imports).toEqual([])
    expect(createNewCustomerMock).not.toHaveBeenCalled()
  })

  it("legt Beleg-Kontakte ohne Dimacon-Gegenstück in Dimacon an", async () => {
    loadAllCustomersMock.mockResolvedValue([
      customer({ id: "cust-alt", customerNumber: "10001", name: "Alt GmbH" }),
    ])
    lexwareServes({
      contacts: [altContact, neuContact],
      vouchers: [
        { id: "v-1", voucherNumber: "AG0004", voucherStatus: "open", contactId: "lex-neu" },
        { id: "v-2", voucherNumber: "AB0001", voucherStatus: "draft", contactId: "lex-alt" },
      ],
    })

    const result = await runDimaconLexofficeSync(testCtx(), { steps: IMPORT_ON })

    expect(voucherQueries()).toEqual([
      expect.objectContaining({ voucherDateFrom: addDays(todayInBerlin(), -14) }),
    ])
    expect(createNewCustomerMock).toHaveBeenCalledTimes(1)
    expect(createNewCustomerMock.mock.calls[0][0].body).toEqual({
      name: "Neu GmbH",
      customerNumber: "10010",
      street: "Weg 1",
      zipCity: "80331 München",
      customAttributeValues: [],
    })
    // Der schon verknüpfte Kontakt erzeugt keine Übernahme-Zeile
    expect(result.imports).toEqual([
      {
        lexwareContactId: "lex-neu",
        lexwareNumber: "10010",
        name: "Neu GmbH",
        vouchers: ["AG0004"],
        dimaconCustomerId: "d-new",
        status: "created",
      },
    ])
  })

  it("übernimmt einen im dry-run per Name zugeordneten Kontakt nicht ein zweites Mal", async () => {
    // Die Namensstufe ordnet zu, schreibt im dry-run aber keine Nummer zurück:
    // der Dimacon-Kunde trägt noch "K-7". Nur die Zuordnungen des
    // Vorwärts-Abgleichs verhindern, dass er als fehlend gilt.
    loadAllCustomersMock.mockResolvedValue([
      customer({ id: "cust-alt", customerNumber: "K-7", name: "Alt GmbH" }),
    ])
    lexwareServes({
      contacts: [altContact, neuContact],
      vouchers: [
        { id: "v-1", voucherNumber: "AG0001", contactId: "lex-alt" },
        { id: "v-2", voucherNumber: "AG0002", contactId: "lex-neu" },
      ],
    })

    const result = await runDimaconLexofficeSync(testCtx(), { dryRun: true, steps: IMPORT_ON })

    expect(rowFor(result, "cust-alt").status).toBe("aligned")
    expect(result.imports).toEqual([
      expect.objectContaining({
        lexwareContactId: "lex-neu",
        status: "created",
        reason: expect.stringContaining("[dryRun]"),
      }),
    ])
    expect(createNewCustomerMock).not.toHaveBeenCalled()
    expect(updateCustomerMock).not.toHaveBeenCalled()
  })

  it("übernimmt auch dann, wenn Dimacon noch gar keine Kunden hat", async () => {
    loadAllCustomersMock.mockResolvedValue([])
    lexwareServes({
      contacts: [neuContact],
      vouchers: [{ id: "v-1", voucherNumber: "AG0004", contactId: "lex-neu" }],
    })

    const result = await runDimaconLexofficeSync(testCtx(), { steps: IMPORT_ON })

    expect(result.imports.map((r) => r.status)).toEqual(["created"])
    expect(createNewCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("legt ohne vollständigen Kontakt-Index nichts an (fail-closed)", async () => {
    loadAllCustomersMock.mockResolvedValue([])
    lexGet.mockImplementation(async (path: string) => {
      // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
      if (path === "/v1/contacts") throw new Error("boom 400")
      return { content: [{ id: "v-1", contactId: "lex-neu" }], totalPages: 1, last: true }
    })

    const result = await runDimaconLexofficeSync(testCtx(), { steps: IMPORT_ON })

    expect(voucherQueries()).toEqual([])
    expect(result.imports).toEqual([])
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "import",
        message: expect.stringContaining("keine Übernahme nach Dimacon"),
      }),
    )
    expect(createNewCustomerMock).not.toHaveBeenCalled()
  })

  it("meldet eine gescheiterte Anlage als failed-Zeile", async () => {
    loadAllCustomersMock.mockResolvedValue([])
    lexwareServes({
      contacts: [neuContact],
      vouchers: [{ id: "v-1", voucherNumber: "AG0004", contactId: "lex-neu" }],
    })
    createNewCustomerMock.mockRejectedValue(new Error("Pflicht-Attribut fehlt 400"))

    const result = await runDimaconLexofficeSync(testCtx(), { steps: IMPORT_ON })

    expect(result.imports).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: expect.stringContaining("Pflicht-Attribut fehlt"),
      }),
    ])
    // Kein Retry: die Anlage ist nicht idempotent
    expect(createNewCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("legt nichts an, solange ein Pflicht-Attribut keine Zuordnung hat", async () => {
    loadAllCustomersMock.mockResolvedValue([])
    lexwareServes({
      contacts: [neuContact],
      vouchers: [{ id: "v-1", voucherNumber: "AG0004", contactId: "lex-neu" }],
    })
    mappingServes([
      { id: "attr-ks", label: "Kostenstelle", type: "STRING", isActive: true, isRequired: true },
    ])

    const result = await runDimaconLexofficeSync(testCtx(), { steps: IMPORT_ON })

    expect(createNewCustomerMock).not.toHaveBeenCalled()
    expect(result.imports).toEqual([
      expect.objectContaining({ lexwareContactId: "lex-neu", status: "skipped" }),
    ])
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "import",
        message: expect.stringContaining('Pflicht-Attribut „Kostenstelle"'),
      }),
    )
  })

  it("überspringt einen Kontakt, dessen Quelle für ein Pflicht-Attribut leer ist", async () => {
    loadAllCustomersMock.mockResolvedValue([])
    lexwareServes({
      contacts: [neuContact],
      vouchers: [{ id: "v-1", voucherNumber: "AG0004", contactId: "lex-neu" }],
    })
    mappingServes(
      [{ id: "attr-ust", label: "USt-IdNr.", type: "STRING", isActive: true, isRequired: true }],
      [
        ...FIELD_CATALOG.dimaconCustomer.defaultRules,
        {
          source: { kind: "standard", field: "vatRegistrationId" },
          target: { kind: "attribute", attributeId: "attr-ust" },
        },
      ],
    )

    const result = await runDimaconLexofficeSync(testCtx(), { steps: IMPORT_ON })

    expect(createNewCustomerMock).not.toHaveBeenCalled()
    expect(result.imports).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: expect.stringContaining('„USt-IdNr." bliebe leer'),
      }),
    ])
  })

  it("schreibt zugeordnete Attribute in den neuen Dimacon-Kunden", async () => {
    loadAllCustomersMock.mockResolvedValue([])
    lexwareServes({
      contacts: [{ ...neuContact, company: { ...neuContact.company, vatRegistrationId: "DE1" } }],
      vouchers: [{ id: "v-1", voucherNumber: "AG0004", contactId: "lex-neu" }],
    })
    mappingServes(
      [{ id: "attr-ust", label: "USt-IdNr.", type: "STRING", isActive: true, isRequired: true }],
      [
        {
          source: { kind: "standard", field: "vatRegistrationId" },
          target: { kind: "attribute", attributeId: "attr-ust" },
        },
      ],
    )

    const result = await runDimaconLexofficeSync(testCtx(), { steps: IMPORT_ON })

    expect(result.imports.map((r) => r.status)).toEqual(["created"])
    // Nur die gespeicherte Regel gilt — die Adresse ist hier bewusst nicht zugeordnet
    expect(createNewCustomerMock.mock.calls[0][0].body).toEqual({
      name: "Neu GmbH",
      customerNumber: "10010",
      customAttributeValues: [{ attributeId: "attr-ust", value: "DE1" }],
    })
  })

  it("legt ohne ladbare Kunden-Attribute nichts an (fail-closed)", async () => {
    loadAllCustomersMock.mockResolvedValue([])
    lexwareServes({
      contacts: [neuContact],
      vouchers: [{ id: "v-1", voucherNumber: "AG0004", contactId: "lex-neu" }],
    })
    loadMappingContextMock.mockImplementation(async ({ entities }: { entities: string[] }) => {
      if (entities.includes("dimaconCustomer")) throw new Error("dimacon down 400")
      return new Map()
    })

    const result = await runDimaconLexofficeSync(testCtx(), { steps: IMPORT_ON })

    expect(createNewCustomerMock).not.toHaveBeenCalled()
    expect(result.imports).toEqual([])
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "import",
        message: expect.stringContaining("Kunden-Attribute konnten nicht geladen werden"),
      }),
    )
  })
})
