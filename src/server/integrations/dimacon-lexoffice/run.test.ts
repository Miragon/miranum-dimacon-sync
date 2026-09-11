import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import type { IntegrationRunContext } from "../types.js"

const updateCustomerMock = vi.fn()
vi.mock("@miragon/client-dimacon", () => ({ sdk: { updateCustomer: updateCustomerMock } }))

const loadAllCustomersMock = vi.fn()
vi.mock("../shared/dimacon.js", () => ({ loadAllCustomers: loadAllCustomersMock }))

const loadMappingContextMock = vi.fn()
vi.mock("../shared/mapping-context.js", () => ({ loadMappingContext: loadMappingContextMock }))

const { runDimaconLexofficeSync } = await import("./run.js")

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

beforeEach(() => {
  vi.resetAllMocks()
  updateCustomerMock.mockResolvedValue({})
  // Leerer Kontext → run.ts fällt auf die Default-Zuordnung zurück
  loadMappingContextMock.mockResolvedValue(new Map())
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

    const result = await runDimaconLexofficeSync(testCtx(), {})

    // Der Voll-Index löst beide Namen lokal auf — kein Request je Kunde,
    // und die Nummernstufe wird (wie bisher) gar nicht erst angefragt.
    expect(lexQueries()).toEqual([INDEX_PAGE])
    // Namen sind eindeutig ⇒ beide werden normal angelegt
    expect(rowFor(result, "cust-1").status).toBe("created")
    expect(rowFor(result, "cust-2").status).toBe("created")
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
