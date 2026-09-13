import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"

const getAListOfCustomersMock = vi.fn()
vi.mock("@miragon/client-clockin", () => ({
  sdk: { getAListOfCustomers: getAListOfCustomersMock },
}))

const { buildIndex, loadClockinCustomerIndex } = await import("./customer-index.js")

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

const stubClient = {} as never

function row(id: number, company: string, identifier: string | null = `K-${id}`) {
  return { id, company, identifier }
}

function page(rows: ReturnType<typeof row>[], currentPage: number, lastPage: number) {
  return { data: rows, meta: { current_page: currentPage, last_page: lastPage, per_page: 2 } }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe("buildIndex", () => {
  it("matches by identifier and by company, normalised", () => {
    const index = buildIndex([row(1, "Muster GmbH", "D-100")])

    expect(index.byIdentifier("d-100").map((r) => r.id)).toEqual([1])
    expect(index.byCompany("  muster   gmbh ").map((r) => r.id)).toEqual([1])
    expect(index.byIdentifier("unbekannt")).toEqual([])
  })

  it("keeps ALL candidates per key — the ambiguity check from #16 depends on it", () => {
    const index = buildIndex([row(1, "Muster GmbH", "D-1"), row(2, "Muster GmbH", "D-2")])

    expect(index.byCompany("Muster GmbH").map((r) => r.id)).toEqual([1, 2])
  })

  it("ignores rows without an id and empty keys", () => {
    const index = buildIndex([{ company: "Ohne Id", identifier: "X" }, row(3, "", null)])

    expect(index.byCompany("Ohne Id")).toEqual([])
    expect(index.byCompany("")).toEqual([])
    expect(index.byIdentifier("")).toEqual([])
    expect(index.size).toBe(1)
  })

  it("makes a customer created during the run findable immediately", () => {
    const index = buildIndex([])

    expect(index.byCompany("Neu GmbH")).toEqual([])
    index.add(row(9, "Neu GmbH", "D-9"))
    expect(index.byCompany("Neu GmbH").map((r) => r.id)).toEqual([9])
    expect(index.byIdentifier("D-9").map((r) => r.id)).toEqual([9])
  })
})

describe("loadClockinCustomerIndex", () => {
  it("loads every page and indexes all rows", async () => {
    getAListOfCustomersMock
      .mockResolvedValueOnce(page([row(1, "A GmbH"), row(2, "B GmbH")], 1, 2))
      .mockResolvedValueOnce(page([row(3, "C GmbH")], 2, 2))

    const index = await loadClockinCustomerIndex(stubClient, {
      neededCustomers: 50,
      log: silentLog,
    })

    expect(getAListOfCustomersMock).toHaveBeenCalledTimes(2)
    // Seite 1 wird NICHT doppelt geholt
    expect(getAListOfCustomersMock.mock.calls[0][0].query).toBeUndefined()
    expect(getAListOfCustomersMock.mock.calls[1][0].query).toEqual({ page: 2 })
    expect(index?.size).toBe(3)
    expect(index?.byCompany("C GmbH").map((r) => r.id)).toEqual([3])
  })

  it("stops after one request when the inventory is paginated but few customers are needed", async () => {
    getAListOfCustomersMock.mockResolvedValue(page([row(1, "A GmbH")], 1, 5))

    const index = await loadClockinCustomerIndex(stubClient, {
      neededCustomers: 3,
      log: silentLog,
    })

    expect(index).toBeUndefined()
    expect(getAListOfCustomersMock).toHaveBeenCalledTimes(1)
  })

  it("discards the index when the pagination is incomplete", async () => {
    // Seite 2 kommt als Seite 1 zurück ⇒ die API ignoriert `page`. Ein halber
    // Index ließe eine Mehrdeutigkeit als „eindeutig" durchgehen.
    getAListOfCustomersMock
      .mockResolvedValueOnce(page([row(1, "A GmbH")], 1, 3))
      .mockResolvedValueOnce(page([row(1, "A GmbH")], 1, 3))

    const index = await loadClockinCustomerIndex(stubClient, {
      neededCustomers: 50,
      log: silentLog,
    })

    expect(index).toBeUndefined()
  })

  it("discards the index when the response carries no meta.last_page", async () => {
    // Ohne `meta` ist unbekannt, ob weitere Seiten folgen. Ein halber Index
    // sähe den Zwilling auf der nicht geladenen Seite nicht und machte aus
    // einer Mehrdeutigkeit (#16) still einen eindeutigen Treffer.
    getAListOfCustomersMock.mockResolvedValue({ data: [row(1, "A GmbH"), row(2, "B GmbH")] })

    const index = await loadClockinCustomerIndex(stubClient, {
      neededCustomers: 50,
      log: silentLog,
    })

    expect(index).toBeUndefined()
    // Genau ein Request — der Vollabruf wird gar nicht erst gestartet.
    expect(getAListOfCustomersMock).toHaveBeenCalledTimes(1)
  })

  it("skips the bulk fetch when the inventory has far more pages than the run needs customers", async () => {
    // 50 Seiten kosten 50 Requests, 9 Kunden einzeln höchstens 18 — der
    // Vollabruf lohnt sich also NICHT, obwohl neededCustomers über der
    // Konstante BULK_FETCH_THRESHOLD (8) liegt.
    getAListOfCustomersMock.mockImplementation((args: { query?: { page?: number } }) => {
      const current = args.query?.page ?? 1
      return Promise.resolve(page([row(current, `Seite ${current} GmbH`)], current, 50))
    })

    const index = await loadClockinCustomerIndex(stubClient, {
      neededCustomers: 9,
      log: silentLog,
    })

    expect(index).toBeUndefined()
    expect(getAListOfCustomersMock).toHaveBeenCalledTimes(1)
  })

  it("skips the bulk fetch when the inventory exceeds the page cap", async () => {
    // 120 Seiten > MAX_CLOCKIN_PAGES (50): `loadAllClockinPages` holte bisher
    // erst die Seiten 2–50 und verwarf den Index danach wegen des Deckels.
    // Der Deckel steht aber schon nach Seite 1 fest.
    getAListOfCustomersMock.mockImplementation((args: { query?: { page?: number } }) => {
      const current = args.query?.page ?? 1
      return Promise.resolve(page([row(current, `Seite ${current} GmbH`)], current, 120))
    })

    const index = await loadClockinCustomerIndex(stubClient, {
      neededCustomers: 500,
      log: silentLog,
    })

    expect(index).toBeUndefined()
    expect(getAListOfCustomersMock).toHaveBeenCalledTimes(1)
  })

  it("still uses the bulk fetch when the inventory sits exactly on the page cap", async () => {
    // Grenze: 50 Seiten sind NOCH vollständig ladbar. Ohne diesen Test bliebe
    // ein `>=` statt `>` im Deckel-Check unentdeckt und schaltete den Index
    // für 50-Seiten-Bestände still ab.
    getAListOfCustomersMock.mockImplementation((args: { query?: { page?: number } }) => {
      const current = args.query?.page ?? 1
      return Promise.resolve(page([row(current, `Seite ${current} GmbH`)], current, 50))
    })

    const index = await loadClockinCustomerIndex(stubClient, {
      neededCustomers: 500,
      log: silentLog,
    })

    expect(index).toBeDefined()
    expect(getAListOfCustomersMock).toHaveBeenCalledTimes(50)
  })

  it("still builds the index when the run needs more customers than the inventory has pages", async () => {
    // Gegenprobe: 3 Seiten gegen 20 Kunden — hier lohnt der Vollabruf.
    getAListOfCustomersMock.mockImplementation((args: { query?: { page?: number } }) => {
      const current = args.query?.page ?? 1
      return Promise.resolve(page([row(current, `Seite ${current} GmbH`)], current, 3))
    })

    const index = await loadClockinCustomerIndex(stubClient, {
      neededCustomers: 20,
      log: silentLog,
    })

    expect(getAListOfCustomersMock).toHaveBeenCalledTimes(3)
    expect(index?.size).toBe(3)
  })

  it("uses the single page without a page query when the inventory fits", async () => {
    getAListOfCustomersMock.mockResolvedValue({ data: [row(1, "A GmbH")], meta: { last_page: 1 } })

    const index = await loadClockinCustomerIndex(stubClient, { neededCustomers: 2 })

    expect(getAListOfCustomersMock).toHaveBeenCalledTimes(1)
    expect(index?.size).toBe(1)
  })
})
