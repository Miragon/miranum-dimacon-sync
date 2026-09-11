import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../lib/log.js"
import type { IntegrationRunContext } from "../types.js"
import { addDays, todayInBerlin } from "../shared/time.js"
import type { LoadedAppointments } from "../shared/dimacon.js"
import type { EnrichedDimaconData } from "./enrichment.js"

// --- Clockin-SDK ---
const searchForProjectsMock = vi.fn()
const createProjectMock = vi.fn()
const updateProjectMock = vi.fn()
const attachEmployeesMock = vi.fn()
const detachEmployeesMock = vi.fn()
const getAListOfProjectEmployeesMock = vi.fn()
const searchForCustomersMock = vi.fn()
const createCustomerMock = vi.fn()
const getAListOfCustomersMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: {
    searchForProjects: searchForProjectsMock,
    createProject: createProjectMock,
    updateProject: updateProjectMock,
    attachEmployees: attachEmployeesMock,
    detachEmployees: detachEmployeesMock,
    getAListOfProjectEmployees: getAListOfProjectEmployeesMock,
    searchForCustomers: searchForCustomersMock,
    createCustomer: createCustomerMock,
    getAListOfCustomers: getAListOfCustomersMock,
  },
}))

// --- Module rund um den Orchestrator ---
const clockinClientStub = { kind: "clockin" }
const dimaconClientStub = { kind: "dimacon" }

const loadAppointmentsMock = vi.fn()
const loadAllCustomersMock = vi.fn()
const loadEmployeesWithEmailMock = vi.fn()
vi.mock("../shared/dimacon.js", () => ({
  loadAppointments: loadAppointmentsMock,
  loadAllCustomers: loadAllCustomersMock,
  loadEmployeesWithEmail: loadEmployeesWithEmailMock,
  BULK_FETCH_THRESHOLD: 8,
}))

const enrichMock = vi.fn()
vi.mock("./enrichment.js", () => ({ enrich: enrichMock }))

const loadMappingContextMock = vi.fn()
vi.mock("../shared/mapping-context.js", () => ({ loadMappingContext: loadMappingContextMock }))

const archiveUnplannedMock = vi.fn()
vi.mock("./archive.js", () => ({
  archiveUnplanned: archiveUnplannedMock,
  archiveHorizonDays: () => 14,
}))

const runEmployeeSyncMock = vi.fn()
vi.mock("./employee-sync/run-employee-sync.js", () => ({
  runEmployeeSync: runEmployeeSyncMock,
}))

const { runDimaconClockinSync } = await import("./run.js")

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

// Tests bauen den Tenant-Kontext von Hand — kein Modul-Mock der Client-
// Factory mehr nötig (genau dafür existiert die ctx-Injektion).
function testCtx(): IntegrationRunContext {
  return {
    tenantId: "tenant-test",
    trigger: "manual",
    clients: {
      tenantId: "tenant-test",
      clockin: async () => clockinClientStub as never,
      dimacon: async () => dimaconClientStub as never,
      lexoffice: async () => ({ kind: "lexoffice" }) as never,
    },
    getFieldMapping: async () => undefined,
    log: silentLog,
  }
}

const DATE = "2026-08-01"
const CLOCKIN_PROJECT_ID = 55

function loadedAppointments(): LoadedAppointments {
  const appointment = {
    id: "appt-1",
    jobId: "job-1",
    teamId: "team-1",
    date: `${DATE}T07:00:00`,
    isArchived: false,
  }
  return {
    appointments: [appointment],
    jobIds: ["job-1"],
    byJobId: new Map([["job-1", [appointment]]]),
    counts: { total: 1, live: 1 },
  }
}

function enrichedData(): EnrichedDimaconData {
  return {
    horizon: { projectIds: new Set(["proj-1"]), complete: true },
    sources: {
      jobs: "period",
      teamAssignments: "none",
      projects: "bulk",
      customers: "preloaded",
    },
    jobs: new Map([
      ["job-1", { jobId: "job-1", projectId: "proj-1", customerId: "cust-1", teamAssignments: [] }],
    ]),
    projects: new Map([
      [
        "proj-1",
        { id: "proj-1", name: "Baustelle A", street: "Musterweg 1", zipCity: "80331 München" },
      ],
    ]),
    customers: new Map([
      ["cust-1", { id: "cust-1", customerNumber: "D-100", name: "Muster GmbH" }],
    ]),
    employees: new Map(),
  }
}

function archiveOptions(): {
  syncedClockinProjectIds: Set<number>
  horizonProjectNumbers: Set<string>
  horizonComplete: boolean
  dryRun: boolean
} {
  return archiveUnplannedMock.mock.calls[0][1]
}

function archivedSet(): Set<number> {
  return archiveOptions().syncedClockinProjectIds
}

/** identisch zum Mock von `archiveHorizonDays` oben */
const HORIZON_DAYS = 14

/** Das Fenster, das der Lauf dem Enrichment mitgibt (undefined = Archiv aus) */
function enrichHorizon(): { from: string; to: string } | undefined {
  return (enrichMock.mock.calls[0][1] as { horizon?: { from: string; to: string } }).horizon
}

// ISO-Daten sind lexikografisch vergleichbar; die Helfer machen die
// Fehlermeldung im Rot-Fall lesbar (beide Werte im Diff).
function atLeast(actual: string | undefined, bound: string): boolean | string {
  return actual !== undefined && actual >= bound ? true : `${String(actual)} < ${bound}`
}

function atMost(actual: string | undefined, bound: string): boolean | string {
  return actual !== undefined && actual <= bound ? true : `${String(actual)} > ${bound}`
}

beforeEach(() => {
  vi.resetAllMocks()

  loadAppointmentsMock.mockResolvedValue(loadedAppointments())
  loadEmployeesWithEmailMock.mockResolvedValue([])
  getAListOfCustomersMock.mockResolvedValue({ data: [], meta: { last_page: 1 } })
  // Gesamtbestand = der eine Tageskunde: keine Namens-Duplikate
  loadAllCustomersMock.mockResolvedValue([
    { id: "cust-1", customerNumber: "D-100", name: "Muster GmbH" },
  ])
  enrichMock.mockResolvedValue(enrichedData())
  // Leerer Kontext → run.ts fällt auf die Default-Zuordnung zurück
  loadMappingContextMock.mockResolvedValue(new Map())
  archiveUnplannedMock.mockResolvedValue([])
  runEmployeeSyncMock.mockResolvedValue({
    counts: { dimacon: 2, clockin: 2, matched: 2 },
    rows: [],
    errors: [],
    pairs: new Map(),
  })

  searchForProjectsMock.mockResolvedValue({
    data: [
      {
        id: CLOCKIN_PROJECT_ID,
        name: "Baustelle A",
        number: "proj-1",
        start_date: `${DATE}T07:30:00`,
        archived: false,
      },
    ],
  })
  getAListOfProjectEmployeesMock.mockResolvedValue({ data: [] })
  searchForCustomersMock.mockResolvedValue({
    data: [{ id: 7, company: "Muster GmbH", identifier: "D-100" }],
  })
  createCustomerMock.mockResolvedValue({ data: { id: 42 } })
  createProjectMock.mockResolvedValue({ data: { id: 99 } })
  updateProjectMock.mockResolvedValue({})
  attachEmployeesMock.mockResolvedValue({})
  detachEmployeesMock.mockResolvedValue({})
})

describe("runDimaconClockinSync (Orchestrierung)", () => {
  it("keeps archive protection intact when the mapping context fails to load (safe mode)", async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    loadMappingContextMock.mockRejectedValue(new Error("boom 400"))

    // Alle Schalter bewusst AN — nur so beweist das gemeldete steps-Objekt,
    // dass der Safe-Mode sie überschreibt (und nicht bloß die Defaults gelten).
    const result = await runDimaconClockinSync(testCtx(), {
      date: DATE,
      steps: {
        employees: true,
        customers: true,
        projects: true,
        assignments: true,
        archive: true,
        employeeCreateInDimacon: true,
      },
    })

    // Safe-Mode: Schreibschritte deaktiviert, Fehler dokumentiert
    expect(result.steps.projects).toBe(false)
    expect(result.steps.customers).toBe(false)
    expect(result.steps.employees).toBe(false)
    expect(result.steps.employeeCreateInDimacon).toBe(false)
    expect(result.errors.some((e) => e.scope === "mapping")).toBe(true)
    expect(runEmployeeSyncMock).not.toHaveBeenCalled()
    expect(result.employeeSync).toBeUndefined()
    expect(createProjectMock).not.toHaveBeenCalled()
    expect(updateProjectMock).not.toHaveBeenCalled()
    expect(createCustomerMock).not.toHaveBeenCalled()

    // Archiv-Phase läuft trotzdem — mit der per searchForProjects
    // aufgelösten Clockin-ID als geschütztem Projekt
    expect(archiveUnplannedMock).toHaveBeenCalledTimes(1)
    expect(archiveUnplannedMock.mock.calls[0][0]).toBe(clockinClientStub)
    expect([...archivedSet()]).toEqual([CLOCKIN_PROJECT_ID])
  })

  it("still protects the resolved project id when the customer sync fails", async () => {
    searchForCustomersMock.mockRejectedValue(new Error("boom 400"))

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.errors).toContainEqual(
      expect.objectContaining({ scope: "customer", refId: "cust-1" }),
    )
    // Der Upsert löst die Clockin-ID trotz Kunden-Fehler auf ...
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].clockinProjectId).toBe(CLOCKIN_PROJECT_ID)
    // ... und die Archiv-Phase bekommt sie als geschützt gemeldet
    expect(archiveUnplannedMock).toHaveBeenCalledTimes(1)
    expect(archivedSet().has(CLOCKIN_PROJECT_ID)).toBe(true)
  })

  it("still protects the resolved project id when the customer match is ambiguous", async () => {
    // Zwei unscharfe Treffer ohne exakten Match ⇒ weder verknüpfen noch anlegen.
    searchForCustomersMock.mockResolvedValue({
      data: [
        { id: 8, company: "Muster Bau GmbH", identifier: "D-1000" },
        { id: 9, company: "Muster Nord GmbH", identifier: "D-1001" },
      ],
    })

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "customer",
        message: expect.stringContaining("2 Clockin-Kandidaten"),
      }),
    )
    expect(createCustomerMock).not.toHaveBeenCalled()
    // Der Upsert löst die Clockin-ID trotz offener Kunden-Zuordnung auf ...
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].clockinProjectId).toBe(CLOCKIN_PROJECT_ID)
    // ... und die Archiv-Phase bekommt sie als geschützt gemeldet
    expect(archiveUnplannedMock).toHaveBeenCalledTimes(1)
    expect(archivedSet().has(CLOCKIN_PROJECT_ID)).toBe(true)
  })

  it("detects duplicate customer names in the full dimacon inventory, not just the day slice", async () => {
    // Zwilling 1001 hat heute KEINEN Termin — im Tagesausschnitt wäre die
    // Namensdublette unsichtbar und der Namens-Fallback verknüpfte den
    // heutigen Kunden 1002 dauerhaft mit dem Clockin-Kunden des Zwillings.
    loadAllCustomersMock.mockResolvedValue([
      { id: "cust-1", customerNumber: "1002", name: "Erdbau Friedberg GmbH" },
      { id: "cust-9", customerNumber: "1001", name: "Erdbau Friedberg GmbH" },
    ])
    enrichMock.mockResolvedValue({
      ...enrichedData(),
      customers: new Map([
        ["cust-1", { id: "cust-1", customerNumber: "1002", name: "Erdbau Friedberg GmbH" }],
      ]),
    })
    searchForCustomersMock.mockImplementation(async (req: unknown) => {
      const needle = (req as { body: { scopes: { parameters: string[] }[] } }).body.scopes[0]
        .parameters[0]
      // Nur der Zwilling steht in Clockin — die Nummernsuche 1002 geht leer aus
      return needle === "Erdbau Friedberg GmbH"
        ? { data: [{ id: 7, company: "Erdbau Friedberg GmbH", identifier: "1001" }] }
        : { data: [] }
    })

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    // Namens-Fallback gesperrt ⇒ nur die Nummernsuche, danach eigener Kunde
    expect(searchForCustomersMock).toHaveBeenCalledTimes(1)
    expect(createCustomerMock).toHaveBeenCalledTimes(1)
    expect(createCustomerMock.mock.calls[0][0]).toMatchObject({
      body: { company: "Erdbau Friedberg GmbH", identifier: "1002" },
    })
    expect(result.errors).toEqual([])
  })

  it("disables the name fallback when the dimacon customer inventory fails to load", async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    loadAllCustomersMock.mockRejectedValue(new Error("boom 400"))
    searchForCustomersMock.mockResolvedValue({ data: [] })

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "customer",
        message: expect.stringContaining("Namens-Fallback"),
      }),
    )
    // Fail-closed: kein zweiter (Namens-)Lookup, stattdessen eigener Kunde
    expect(searchForCustomersMock).toHaveBeenCalledTimes(1)
    expect(createCustomerMock).toHaveBeenCalledTimes(1)
  })

  it("skips the archive phase entirely when steps.archive is disabled", async () => {
    const result = await runDimaconClockinSync(testCtx(), {
      date: DATE,
      steps: {
        employees: true,
        customers: true,
        projects: true,
        assignments: true,
        archive: false,
        employeeCreateInDimacon: false,
      },
    })

    expect(result.errors).toEqual([])
    expect(result.steps.archive).toBe(false)
    expect(archiveUnplannedMock).not.toHaveBeenCalled()
    expect(result.archived).toEqual([])
  })

  it("runs the employee master sync before the daily plan and reports its outcome", async () => {
    runEmployeeSyncMock.mockResolvedValue({
      counts: { dimacon: 3, clockin: 2, matched: 2 },
      rows: [{ direction: "dimacon→clockin", name: "Laura Officanis", status: "created" }],
      errors: [{ scope: "employee", refId: "e-1", message: "boom" }],
      pairs: new Map([["e-1", 77]]),
    })

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(runEmployeeSyncMock).toHaveBeenCalledTimes(1)
    expect(result.employeeSync).toEqual({
      counts: { dimacon: 3, clockin: 2, matched: 2 },
      rows: [{ direction: "dimacon→clockin", name: "Laura Officanis", status: "created" }],
    })
    // Fehler des Abgleichs landen im gemeinsamen errors-Array
    expect(result.errors).toContainEqual(
      expect.objectContaining({ scope: "employee", refId: "e-1" }),
    )
    // Tagesplanung lief danach normal weiter
    expect(result.projects).toHaveLength(1)
  })

  it("carries the employee sync result through the no-appointments early exit", async () => {
    loadAppointmentsMock.mockResolvedValue({
      appointments: [],
      jobIds: [],
      byJobId: new Map(),
      counts: { total: 2, live: 0 },
    })

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    // Stammdaten-Abgleich lief trotz leerer Tagesplanung — Ergebnis erhalten
    expect(runEmployeeSyncMock).toHaveBeenCalledTimes(1)
    expect(result.employeeSync?.counts).toEqual({ dimacon: 2, clockin: 2, matched: 2 })
    expect(result.projects).toEqual([])
    expect(archiveUnplannedMock).not.toHaveBeenCalled()
  })

  it("carries the employee sync result when the appointments load fails", async () => {
    loadAppointmentsMock.mockRejectedValue(new Error("boom 400"))

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.employeeSync).toBeDefined()
    expect(result.errors).toContainEqual(expect.objectContaining({ scope: "appointments" }))
  })

  it("keeps the dimacon creation switch off unless the input asks for it", async () => {
    await runDimaconClockinSync(testCtx(), { date: DATE })
    expect(runEmployeeSyncMock.mock.calls[0][3]).toEqual({ dryRun: false, createInDimacon: false })

    runEmployeeSyncMock.mockClear()

    await runDimaconClockinSync(testCtx(), {
      date: DATE,
      dryRun: true,
      steps: {
        employees: true,
        customers: true,
        projects: true,
        assignments: true,
        archive: true,
        employeeCreateInDimacon: true,
      },
    })
    expect(runEmployeeSyncMock.mock.calls[0][3]).toEqual({ dryRun: true, createInDimacon: true })
  })

  it("starts the employee sync BEFORE the appointments load resolves", async () => {
    // Phase 1 und Phase 2 dürfen sich überlappen — sie belasten
    // unterschiedliche Systeme und hängen nicht voneinander ab.
    let releaseAppointments: () => void = () => undefined
    loadAppointmentsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAppointments = () => resolve(loadedAppointments())
        }),
    )

    const promise = runDimaconClockinSync(testCtx(), { date: DATE })

    // Der Stammdaten-Abgleich läuft an, obwohl die Termine noch offen sind.
    await vi.waitFor(() => expect(runEmployeeSyncMock).toHaveBeenCalledTimes(1))
    expect(loadAppointmentsMock).toHaveBeenCalledTimes(1)

    releaseAppointments()
    const result = await promise
    expect(result.employeeSync).toBeDefined()
    expect(result.projects).toHaveLength(1)
  })

  it("awaits the parallel employee sync even when it rejects on an early exit", async () => {
    // Ohne das angehängte .catch() wäre das eine unhandled rejection.
    loadAppointmentsMock.mockResolvedValue({
      appointments: [],
      jobIds: [],
      byJobId: new Map(),
      counts: { total: 0, live: 0 },
    })
    runEmployeeSyncMock.mockRejectedValue(new Error("boom 400"))

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.employeeSync).toBeUndefined()
    expect(result.errors).toContainEqual(
      expect.objectContaining({ scope: "employee", message: expect.stringContaining("boom") }),
    )
  })

  it("carries the employee sync result through the enrichment failure exit", async () => {
    enrichMock.mockRejectedValue(new Error("boom 400"))

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.employeeSync?.counts).toEqual({ dimacon: 2, clockin: 2, matched: 2 })
    expect(result.errors).toContainEqual(expect.objectContaining({ scope: "enrichment" }))
  })

  it("loads the dimacon employees once and hands them to both phases", async () => {
    const employees = [{ id: "e-1", firstName: "Anna", lastName: "Muster" }]
    loadEmployeesWithEmailMock.mockResolvedValue(employees)

    await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(loadEmployeesWithEmailMock).toHaveBeenCalledTimes(1)
    expect(runEmployeeSyncMock.mock.calls[0][6]).toBe(employees)
    expect(enrichMock.mock.calls[0][1].employees).toBe(employees)
  })

  it("passes the loaded dimacon customers into the enrichment", async () => {
    // Der Gesamtbestand wird ohnehin geladen — damit kostet die
    // Kunden-Auflösung im Enrichment keinen einzigen Request.
    await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(enrichMock.mock.calls[0][1].customers).toEqual([
      { id: "cust-1", customerNumber: "D-100", name: "Muster GmbH" },
    ])
  })

  it("hands both protection sets to the archive phase", async () => {
    await runDimaconClockinSync(testCtx(), { date: DATE })

    expect([...archiveOptions().syncedClockinProjectIds]).toEqual([CLOCKIN_PROJECT_ID])
    expect([...archiveOptions().horizonProjectNumbers]).toEqual(["proj-1"])
    expect(archiveOptions().horizonComplete).toBe(true)
  })

  it("reports an unknown horizon and lets the archive phase refuse to write", async () => {
    enrichMock.mockResolvedValue({
      ...enrichedData(),
      horizon: { projectIds: new Set(), complete: false, reason: "Termine nicht ladbar" },
    })

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(archiveOptions().horizonComplete).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "archive",
        message: expect.stringContaining("Planungshorizont"),
      }),
    )
  })

  it("falls back to per-project searches when the prefetch fails", async () => {
    // Non-transient halten ("400"): withRetry darf nicht ins Backoff laufen
    searchForProjectsMock.mockRejectedValueOnce(new Error("prefetch boom 400"))

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "load",
        message: expect.stringContaining("Clockin-Projekte"),
      }),
    )
    // Der Lauf arbeitet weiter — mit der Einzelsuche je Projekt
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].clockinProjectId).toBe(CLOCKIN_PROJECT_ID)
    expect(archivedSet().has(CLOCKIN_PROJECT_ID)).toBe(true)
  })

  it("falls back to per-customer searches when the customer index fails", async () => {
    getAListOfCustomersMock.mockRejectedValue(new Error("index boom 400"))

    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        scope: "load",
        message: expect.stringContaining("Clockin-Kundenbestand"),
      }),
    )
    expect(searchForCustomersMock).toHaveBeenCalled()
    expect(result.projects[0].clockinProjectId).toBe(CLOCKIN_PROJECT_ID)
  })

  it("reports which lookup path the run took", async () => {
    const result = await runDimaconClockinSync(testCtx(), { date: DATE })

    expect(result.lookups).toEqual({
      jobs: "period",
      teamAssignments: "none",
      projects: "bulk",
      customers: "preloaded",
      clockinCustomerIndex: true,
      clockinProjectPrefetch: "bundled",
      archiveHorizonDays: 14,
    })
  })

  // --- Archiv-Horizont ---------------------------------------------------
  //
  // LOAD-BEARING: `date` ist frei wählbar (Run-Formular, Webhook). Hinge der
  // Horizont allein daran, würde ein Live-Lauf für ein vergangenes Datum den
  // gesamten heute eingeplanten Bestand archivieren.

  it("spans the archive horizon over today AND the run date for a past run", async () => {
    const today = todayInBerlin()
    const pastDate = addDays(today, -60)

    await runDimaconClockinSync(testCtx(), { date: pastDate })

    const horizon = enrichHorizon()
    expect(horizon).toBeDefined()
    // Untergrenze hängt am (älteren) Run-Datum ...
    expect(horizon?.from).toBe(addDays(pastDate, -HORIZON_DAYS))
    // ... die Obergrenze deckt trotzdem heute + N Tage ab. Genau hier lag der
    // Defekt: `addDays(pastDate, N + 1)` läge 60 Tage zu früh.
    expect(atLeast(horizon?.to, addDays(today, HORIZON_DAYS))).toBe(true)
  })

  it("spans the archive horizon over today AND the run date for a future run", async () => {
    const today = todayInBerlin()
    const futureDate = addDays(today, 60)

    await runDimaconClockinSync(testCtx(), { date: futureDate })

    const horizon = enrichHorizon()
    // Obergrenze hängt am (späteren) Run-Datum ...
    expect(horizon?.to).toBe(addDays(futureDate, HORIZON_DAYS + 1))
    // ... die Untergrenze reicht trotzdem bis N Tage vor heute zurück.
    expect(atMost(horizon?.from, addDays(today, -HORIZON_DAYS))).toBe(true)
  })

  it("keeps the horizon at ±N days around today for a run for today (Gegenprobe)", async () => {
    const today = todayInBerlin()

    await runDimaconClockinSync(testCtx(), { date: today })

    // Ohne zweiten Anker bleibt das Fenster eng — der Fix weitet nicht pauschal.
    expect(enrichHorizon()).toEqual({
      from: addDays(today, -HORIZON_DAYS),
      to: addDays(today, HORIZON_DAYS + 1),
    })
  })

  it("passes no horizon at all when the archive step is disabled", async () => {
    await runDimaconClockinSync(testCtx(), {
      date: addDays(todayInBerlin(), -60),
      steps: {
        employees: true,
        customers: true,
        projects: true,
        assignments: true,
        archive: false,
        employeeCreateInDimacon: false,
      },
    })

    expect(enrichMock).toHaveBeenCalledTimes(1)
    expect(enrichHorizon()).toBeUndefined()
  })

  it("skips the employee master sync when steps.employees is disabled", async () => {
    const result = await runDimaconClockinSync(testCtx(), {
      date: DATE,
      steps: {
        employees: false,
        customers: true,
        projects: true,
        assignments: true,
        archive: true,
        employeeCreateInDimacon: false,
      },
    })

    expect(runEmployeeSyncMock).not.toHaveBeenCalled()
    expect(result.employeeSync).toBeUndefined()
    expect(result.projects).toHaveLength(1)
  })
})
