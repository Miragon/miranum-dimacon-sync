import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../../lib/log.js"
import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import type { EntityMappingContext } from "../../shared/mapping-context.js"

// --- Clockin-SDK ---
const getAListOfEmployeesMock = vi.fn()
const searchForEmployeesMock = vi.fn()
const clockinCreateEmployeeMock = vi.fn()
const clockinUpdateEmployeeMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: {
    getAListOfEmployees: getAListOfEmployeesMock,
    searchForEmployees: searchForEmployeesMock,
    createEmployee: clockinCreateEmployeeMock,
    updateEmployee: clockinUpdateEmployeeMock,
  },
}))

// --- Dimacon-SDK ---
const dimaconCreateEmployeeMock = vi.fn()
const dimaconUpdateEmployeeMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: { createNewEmployee: dimaconCreateEmployeeMock, updateEmployee: dimaconUpdateEmployeeMock },
}))

const loadEmployeesWithEmailMock = vi.fn()
vi.mock("../../shared/dimacon.js", () => ({
  loadEmployeesWithEmail: loadEmployeesWithEmailMock,
}))

const { runEmployeeSync } = await import("./run-employee-sync.js")
const { FIELD_CATALOG } = await import("../../shared/field-catalog.js")
const { EMPTY_DISCOVERY } = await import("../../shared/field-mapping.js")

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

const mapping: EntityMappingContext = {
  entity: "employee",
  rules: FIELD_CATALOG.employee.defaultRules,
  catalog: FIELD_CATALOG.employee,
  discovery: EMPTY_DISCOVERY,
  isCustomized: false,
  hasCustomTargets: false,
}

const stubDimaconClient = {} as never
const stubClockinClient = {} as never

function dim(overrides: Partial<DimaconEmployeeFull> = {}): DimaconEmployeeFull {
  return {
    id: "d1",
    firstName: "Dima",
    lastName: "Conner",
    role: "CRAFTSMAN",
    color: "#A1A1AA",
    timeTrackingActive: true,
    isArchived: false,
    ...overrides,
  }
}

function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    first_name: "Clock",
    last_name: `Iner${id}`,
    personnel_number: `P-${id}`,
    ...overrides,
  }
}

function page(current: number, lastPage: number, rows: Record<string, unknown>[]) {
  return { data: rows, meta: { current_page: current, last_page: lastPage, per_page: rows.length } }
}

function run(
  options: {
    dryRun?: boolean
    createInDimacon?: boolean
    hasCustomTargets?: boolean
    preloaded?: readonly DimaconEmployeeFull[]
  } = {},
) {
  return runEmployeeSync(
    stubDimaconClient,
    stubClockinClient,
    { ...mapping, hasCustomTargets: options.hasCustomTargets ?? false },
    { dryRun: options.dryRun ?? false, createInDimacon: options.createInDimacon ?? false },
    silentLog,
    noop,
    options.preloaded,
  )
}

/** Query-Argumente der Mitarbeiter-Liste in Aufrufreihenfolge */
function pageQueries(): unknown[] {
  return getAListOfEmployeesMock.mock.calls.map((c) => c[0].query)
}

/** Query-Argumente der Search-API (Ladepfad mit Custom-Feldern) */
function searchPageQueries(): unknown[] {
  return searchForEmployeesMock.mock.calls.map((c) => c[0].query)
}

beforeEach(() => {
  vi.resetAllMocks()
  loadEmployeesWithEmailMock.mockResolvedValue([])
  getAListOfEmployeesMock.mockResolvedValue(page(1, 1, [row(1)]))
  clockinCreateEmployeeMock.mockResolvedValue({ data: { id: 55 } })
  clockinUpdateEmployeeMock.mockResolvedValue({})
  dimaconCreateEmployeeMock.mockResolvedValue({ id: "d-new" })
  dimaconUpdateEmployeeMock.mockResolvedValue({})
})

describe("runEmployeeSync — Paginierung des Clockin-Bestands", () => {
  it("reads every page and counts all employees", async () => {
    getAListOfEmployeesMock.mockImplementation(async ({ query }: { query?: { page?: number } }) => {
      const current = query?.page ?? 1
      return page(current, 3, [row(current * 10 + 1), row(current * 10 + 2)])
    })

    const outcome = await run()

    expect(getAListOfEmployeesMock).toHaveBeenCalledTimes(3)
    // Seite 1 ohne page-Query, danach mit
    expect(pageQueries()).toEqual([undefined, { page: 2 }, { page: 3 }])
    expect(outcome.counts.clockin).toBe(6)
    expect(outcome.errors).toEqual([])
  })

  it("paginates the search endpoint too when custom fields are mapped", async () => {
    // Mit Custom-Zielen läuft der Bestand über die Search-API — auch dieser
    // Pfad MUSS die Seite mitschicken, sonst greift der Vollständigkeits-Wächter.
    searchForEmployeesMock.mockImplementation(async ({ query }: { query?: { page?: number } }) => {
      const current = query?.page ?? 1
      return page(current, 3, [row(current * 10 + 1), row(current * 10 + 2)])
    })

    const outcome = await run({ hasCustomTargets: true })

    expect(getAListOfEmployeesMock).not.toHaveBeenCalled()
    expect(searchForEmployeesMock).toHaveBeenCalledTimes(3)
    expect(searchPageQueries()).toEqual([undefined, { page: 2 }, { page: 3 }])
    // Custom-Feld-Werte kommen nur über den includes-Body mit
    expect(searchForEmployeesMock.mock.calls[0][0].body).toEqual({
      includes: [{ relation: "customFields" }],
    })
    expect(outcome.counts.clockin).toBe(6)
    expect(outcome.errors).toEqual([])
  })

  it("stops and creates nothing when the api ignores the page parameter", async () => {
    // current_page bleibt 1 ⇒ Vergleichsbasis nachweislich unvollständig
    getAListOfEmployeesMock.mockResolvedValue(page(1, 4, [row(1), row(2)]))
    loadEmployeesWithEmailMock.mockResolvedValue([dim()])

    const outcome = await run({ createInDimacon: true })

    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0]).toMatchObject({ scope: "load", refId: "clockin" })
    expect(outcome.errors[0].message).toContain("unvollständig geladen")
    expect(dimaconCreateEmployeeMock).not.toHaveBeenCalled()
    expect(clockinCreateEmployeeMock).not.toHaveBeenCalled()

    // je eine Sammelzeile pro Richtung, statt stiller Anlage
    expect(outcome.rows).toEqual([
      {
        direction: "clockin→dimacon",
        name: "(2 Kandidaten)",
        status: "skipped",
        reason: "Clockin-Bestand unvollständig geladen — keine Anlage",
      },
      {
        direction: "dimacon→clockin",
        name: "(1 Kandidat)",
        status: "skipped",
        reason: "Clockin-Bestand unvollständig geladen — nicht in Clockin angelegt",
      },
    ])
  })

  it("creates nothing when the response carries no meta.last_page", async () => {
    // Ohne `meta` ist unbekannt, ob weitere Seiten folgen — dieselbe
    // fail-closed-Entscheidung wie beim Kunden-Index.
    getAListOfEmployeesMock.mockResolvedValue({ data: [row(1)] })
    loadEmployeesWithEmailMock.mockResolvedValue([dim()])

    const outcome = await run({ createInDimacon: true })

    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0]).toMatchObject({ scope: "load", refId: "clockin" })
    expect(outcome.errors[0].message).toContain("unvollständig geladen")
    expect(clockinCreateEmployeeMock).not.toHaveBeenCalled()
    expect(dimaconCreateEmployeeMock).not.toHaveBeenCalled()
    // Die user-sichtbaren Sammelzeilen: keine stille Nicht-Anlage.
    expect(outcome.rows.map((r) => r.status)).toEqual(["skipped", "skipped"])
    // Die eine geladene Seite zählt weiterhin mit
    expect(outcome.counts.clockin).toBe(1)
  })

  it("keeps running but creates nothing when a follow-up page fails", async () => {
    getAListOfEmployeesMock.mockImplementation(async ({ query }: { query?: { page?: number } }) => {
      if (query?.page === 2) throw new Error("boom 400")
      return page(1, 2, [row(1)])
    })
    loadEmployeesWithEmailMock.mockResolvedValue([dim()])

    const outcome = await run({ createInDimacon: true })

    // Der Lauf bricht nicht ab — die geladene Seite zählt weiter mit
    expect(outcome.counts.clockin).toBe(1)
    expect(outcome.errors[0].message).toContain("Seite 2 konnte nicht geladen werden")
    expect(dimaconCreateEmployeeMock).not.toHaveBeenCalled()
    expect(clockinCreateEmployeeMock).not.toHaveBeenCalled()
  })

  it("returns early when the very first page fails", async () => {
    getAListOfEmployeesMock.mockRejectedValue(new Error("boom 400"))
    loadEmployeesWithEmailMock.mockResolvedValue([dim()])

    const outcome = await run({ createInDimacon: true })

    expect(outcome.counts).toEqual({ dimacon: 1, clockin: 0, matched: 0 })
    expect(outcome.rows).toEqual([])
    expect(outcome.errors).toEqual([
      { scope: "load", refId: "clockin", message: expect.stringContaining("boom 400") },
    ])
    expect(clockinCreateEmployeeMock).not.toHaveBeenCalled()
  })
})

describe("runEmployeeSync — Anlage Clockin → Dimacon", () => {
  it("aggregates every candidate into one row while the switch is off", async () => {
    getAListOfEmployeesMock.mockResolvedValue(page(1, 1, [row(1), row(2), row(3)]))

    const outcome = await run({ createInDimacon: false })

    expect(dimaconCreateEmployeeMock).not.toHaveBeenCalled()
    expect(outcome.rows).toEqual([
      {
        direction: "clockin→dimacon",
        name: "(3 Kandidaten)",
        status: "skipped",
        reason: "Anlage in Dimacon deaktiviert (Schritt „Mitarbeiter in Dimacon anlegen“)",
      },
    ])
  })

  it("creates a relevant candidate once the switch is on", async () => {
    getAListOfEmployeesMock.mockResolvedValue(page(1, 1, [row(7)]))

    const outcome = await run({ createInDimacon: true })

    expect(dimaconCreateEmployeeMock).toHaveBeenCalledTimes(1)
    expect(dimaconCreateEmployeeMock.mock.calls[0][0].body).toMatchObject({
      firstName: "Clock",
      lastName: "Iner7",
      personnelNumber: "P-7",
      role: "CRAFTSMAN",
    })
    expect(outcome.rows).toHaveLength(1)
    expect(outcome.rows[0]).toMatchObject({ direction: "clockin→dimacon", status: "created" })
  })

  it("reports irrelevant candidates per row instead of creating them", async () => {
    getAListOfEmployeesMock.mockResolvedValue(
      page(1, 1, [
        row(1, { personnel_number: "" }),
        row(2, { first_name: "Hans-Peter", last_name: "Müller" }),
        row(3, { contract_ending: "2000-01-31" }),
        // Dublette des per Personalnummer gematchten Datensatzes #4
        row(5, { first_name: "Dima", last_name: "Conner", personnel_number: "" }),
        row(4, { personnel_number: "P-MATCH", first_name: "Dima", last_name: "Conner" }),
      ]),
    )
    loadEmployeesWithEmailMock.mockResolvedValue([
      dim({ personnelNumber: "P-MATCH" }),
      dim({ id: "d2", firstName: "Hans Peter", lastName: "Mueller" }),
    ])

    const outcome = await run({ createInDimacon: true })

    expect(dimaconCreateEmployeeMock).not.toHaveBeenCalled()
    const skipped = outcome.rows.filter((r) => r.direction === "clockin→dimacon")
    expect(skipped.map((r) => [r.clockinId, r.reason])).toEqual([
      [1, "keine Personalnummer in Clockin — Zuordnung nicht eindeutig"],
      [2, "ähnlicher Name in Dimacon vorhanden (Hans Peter Mueller) — bitte manuell prüfen"],
      [3, "Vertrag endete am 2000-01-31"],
      [5, "Dublette in Clockin zu bereits zugeordnetem Datensatz #4"],
    ])
  })

  it("creates only one of two clockin duplicates that are both new", async () => {
    // Beide Datensätze sind dieselbe Person und in Dimacon unbekannt — ohne
    // Dubletten-Sperre entstünden zwei teamlose Dimacon-Mitarbeiter (Issue #17).
    getAListOfEmployeesMock.mockResolvedValue(
      page(1, 1, [
        row(1, { first_name: "Max", last_name: "Mustermann", personnel_number: "P-9" }),
        row(2, { first_name: "Max", last_name: "Mustermann", personnel_number: "P-9" }),
      ]),
    )

    const outcome = await run({ createInDimacon: true })

    expect(dimaconCreateEmployeeMock).toHaveBeenCalledTimes(1)
    expect(dimaconCreateEmployeeMock.mock.calls[0][0].body).toMatchObject({
      personnelNumber: "P-9",
    })
    expect(outcome.rows).toContainEqual({
      direction: "clockin→dimacon",
      clockinId: 2,
      name: "Max Mustermann",
      status: "skipped",
      reason: "Dublette in Clockin zu Datensatz #1",
    })
  })

  it("caps the skipped rows and adds a remainder row", async () => {
    const rows = Array.from({ length: 205 }, (_, i) => row(i + 1, { personnel_number: "" }))
    getAListOfEmployeesMock.mockResolvedValue(page(1, 1, rows))

    const outcome = await run({ createInDimacon: true })

    expect(outcome.rows).toHaveLength(201)
    expect(outcome.rows[200]).toEqual({
      direction: "clockin→dimacon",
      name: "(5 weitere Kandidaten)",
      status: "skipped",
      // kein Verweis auf Log-Zeilen, die es pro Kandidat nicht gibt
      reason: "nicht angelegt — Ergebnis auf 200 Einzelbegründungen begrenzt",
    })
  })
})

describe("runEmployeeSync — vorgeladene Dimacon-Mitarbeiter (#15)", () => {
  it("verzichtet auf den eigenen Abruf, wenn der Orchestrator sie schon hat", async () => {
    const outcome = await run({ preloaded: [dim({ id: "d1", personnelNumber: "P-1" })] })

    expect(loadEmployeesWithEmailMock).not.toHaveBeenCalled()
    expect(outcome.counts.dimacon).toBe(1)
  })

  it("lädt selbst, wenn nichts vorgeladen wurde", async () => {
    loadEmployeesWithEmailMock.mockResolvedValue([dim()])

    const outcome = await run()

    expect(loadEmployeesWithEmailMock).toHaveBeenCalledTimes(1)
    expect(outcome.counts.dimacon).toBe(1)
  })

  it('meldet den Ladefehler weiterhin mit scope "load"', async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    loadEmployeesWithEmailMock.mockRejectedValue(new Error("boom 400"))

    const outcome = await run()

    expect(outcome.counts).toEqual({ dimacon: 0, clockin: 0, matched: 0 })
    expect(outcome.errors).toContainEqual(
      expect.objectContaining({ scope: "load", refId: "dimacon" }),
    )
  })
})
