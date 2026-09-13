import { beforeEach, describe, expect, it, vi } from "vitest"
import { FIELD_CATALOG } from "../shared/field-catalog.js"
import { EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { startDateForClockin } from "../shared/time.js"
import type { DimaconProjectInfo } from "./enrichment.js"
import { DEFAULT_STEPS } from "./types.js"
import type { CustomerMapping, SyncSteps } from "./types.js"

const searchForProjectsMock = vi.fn()
const createProjectMock = vi.fn()
const updateProjectMock = vi.fn()
const attachEmployeesMock = vi.fn()
const detachEmployeesMock = vi.fn()
const getAListOfProjectEmployeesMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: {
    searchForProjects: searchForProjectsMock,
    createProject: createProjectMock,
    updateProject: updateProjectMock,
    attachEmployees: attachEmployeesMock,
    detachEmployees: detachEmployeesMock,
    getAListOfProjectEmployees: getAListOfProjectEmployeesMock,
  },
}))

const { ProjectUpserter } = await import("./projects.js")
const { log } = await import("../../lib/log.js")

const silentLog = log.child({ test: true })
;(silentLog as unknown as { info: () => void }).info = () => {
  /* swallow */
}

const stubClient = {} as never

const date = "2026-08-14"

const project: DimaconProjectInfo = {
  id: "proj-1",
  name: "Baustelle Nord",
  street: "Musterweg 1",
  zipCity: "80331 München",
}

const customer: CustomerMapping = {
  dimaconId: "cust-1",
  clockinId: 7,
  number: "D-100",
  name: "Muster GmbH",
}

// Default-Regeln + EMPTY_DISCOVERY = das bisher hartkodierte Verhalten
const mapping: EntityMappingContext = {
  entity: "project",
  rules: FIELD_CATALOG.project.defaultRules,
  catalog: FIELD_CATALOG.project,
  discovery: EMPTY_DISCOVERY,
  isCustomized: false,
  hasCustomTargets: false,
}

/** Clockin-Row, die exakt dem gemappten Soll-Zustand entspricht (→ unchanged) */
function matchingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 55,
    name: "Baustelle Nord",
    number: "proj-1",
    start_date: `${date}T07:30:00+02:00`,
    archived: false,
    destination_street: "Musterweg 1",
    destination_zip: "80331",
    destination_city: "München",
    ...overrides,
  }
}

/** Voller Write-Body aus Default-Zuordnung + fixierten Feldern */
function fullBody(extra: Record<string, unknown> = {}) {
  return {
    name: "Baustelle Nord",
    destination_street: "Musterweg 1",
    destination_zip: "80331",
    destination_city: "München",
    number: "proj-1",
    customer_id: 7,
    start_date: startDateForClockin(date),
    ...extra,
  }
}

function makeUpserter(
  opts: {
    dryRun?: boolean
    steps?: Partial<SyncSteps>
    onResolved?: (id: number) => void
  } = {},
) {
  return new ProjectUpserter(
    stubClient,
    silentLog,
    opts.dryRun ?? false,
    { ...DEFAULT_STEPS, ...opts.steps },
    mapping,
    () => undefined,
    opts.onResolved ?? (() => undefined),
  )
}

function expectNoWrites() {
  expect(createProjectMock).not.toHaveBeenCalled()
  expect(updateProjectMock).not.toHaveBeenCalled()
  expect(attachEmployeesMock).not.toHaveBeenCalled()
  expect(detachEmployeesMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  searchForProjectsMock.mockReset()
  createProjectMock.mockReset()
  updateProjectMock.mockReset()
  attachEmployeesMock.mockReset()
  detachEmployeesMock.mockReset()
  getAListOfProjectEmployeesMock.mockReset()
  updateProjectMock.mockResolvedValue({})
  attachEmployeesMock.mockResolvedValue({})
  detachEmployeesMock.mockResolvedValue({})
  getAListOfProjectEmployeesMock.mockResolvedValue({ data: [] })
})

describe("ProjectUpserter", () => {
  it("leaves a fully matching project unchanged and reports it as resolved", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [matchingRow()] })
    getAListOfProjectEmployeesMock.mockResolvedValue({ data: [{ id: 2 }, { id: 3 }] })
    const onResolved = vi.fn()
    const upserter = makeUpserter({ onResolved })

    const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [2, 3] })

    expect(result.status).toBe("unchanged")
    expect(result.clockinProjectId).toBe(55)
    expectNoWrites()
    expect(onResolved).toHaveBeenCalledWith(55)
  })

  describe("update triggers", () => {
    it.each([
      ["archived project is re-planned", matchingRow({ archived: true })],
      ["number drifted", matchingRow({ number: "old-number" })],
      ["mapped field drifted (name)", matchingRow({ name: "Alter Name" })],
    ])("writes exactly one full update when %s", async (_label, row) => {
      searchForProjectsMock.mockResolvedValue({ data: [row] })
      const upserter = makeUpserter()

      const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

      expect(result.status).toBe("updated")
      expect(updateProjectMock).toHaveBeenCalledTimes(1)
      expect(updateProjectMock.mock.calls[0][0]).toEqual({
        client: stubClient,
        path: { project: 55 },
        body: fullBody({ archived: false }),
      })
      expect(createProjectMock).not.toHaveBeenCalled()
    })
  })

  describe("start_date (Regression #15)", () => {
    it("does NOT write when only start_date differs", async () => {
      // Vorher setzte buildBody start_date auf das Sync-Datum und der
      // Vergleich schlug damit für JEDES an einem anderen Tag
      // synchronisierte Projekt an — jeder Lauf schrieb praktisch jedes
      // Projekt. Das Clockin-Startdatum bleibt jetzt stehen.
      searchForProjectsMock.mockResolvedValue({
        data: [matchingRow({ start_date: "2026-08-13T07:30:00+02:00" })],
      })
      const upserter = makeUpserter()

      const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

      expect(result.status).toBe("unchanged")
      expectNoWrites()
    })

    it("echoes the existing start_date in a real update body", async () => {
      searchForProjectsMock.mockResolvedValue({
        data: [matchingRow({ name: "Alter Name", start_date: "2026-08-13T07:30:00+02:00" })],
      })
      const upserter = makeUpserter()

      await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

      expect(updateProjectMock.mock.calls[0][0]).toEqual({
        client: stubClient,
        path: { project: 55 },
        body: fullBody({ archived: false, start_date: "2026-08-13T07:30:00+02:00" }),
      })
    })

    it("uses the sync date as start_date when creating", async () => {
      searchForProjectsMock.mockResolvedValue({ data: [] })
      createProjectMock.mockResolvedValue({ data: { id: 99 } })
      const upserter = makeUpserter()

      await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

      expect(createProjectMock.mock.calls[0][0]).toEqual({
        client: stubClient,
        body: fullBody(),
      })
    })

    it("falls back to the sync date when the existing row has no start_date", async () => {
      searchForProjectsMock.mockResolvedValue({
        data: [matchingRow({ name: "Alter Name", start_date: null })],
      })
      const upserter = makeUpserter()

      await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

      expect(updateProjectMock.mock.calls[0][0]).toMatchObject({
        body: { start_date: startDateForClockin(date) },
      })
    })
  })

  describe("Prefetch (#15)", () => {
    function prefetch(rows: Record<string, unknown>[]) {
      return {
        get: (id: string) => (id === "proj-1" ? rows : []),
        bundled: true,
        size: rows.length,
      }
    }

    function makePrefetchedUpserter(rows: Record<string, unknown>[]) {
      return new ProjectUpserter(
        stubClient,
        silentLog,
        false,
        DEFAULT_STEPS,
        mapping,
        () => undefined,
        () => undefined,
        prefetch(rows) as never,
      )
    }

    it("never searches when the row comes from the prefetch", async () => {
      const upserter = makePrefetchedUpserter([matchingRow({ employees: [] })])

      const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

      expect(result.status).toBe("unchanged")
      expect(searchForProjectsMock).not.toHaveBeenCalled()
      expect(getAListOfProjectEmployeesMock).not.toHaveBeenCalled()
    })

    it("derives the attach/detach delta from the included employees", async () => {
      const upserter = makePrefetchedUpserter([matchingRow({ employees: [{ id: 1 }, { id: 2 }] })])

      const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [2, 3] })

      expect(getAListOfProjectEmployeesMock).not.toHaveBeenCalled()
      expect(result.employeesAttached).toEqual([3])
      expect(result.employeesDetached).toEqual([1])
    })

    it("still reads the employees when the row carries none", async () => {
      // Ohne `employees`-Key (includes nicht angefragt) bleibt der Einzelabruf
      // der Fallback — ein LEERES Array ist dagegen eine gültige Antwort.
      getAListOfProjectEmployeesMock.mockResolvedValue({ data: [{ id: 9 }] })
      const upserter = makePrefetchedUpserter([matchingRow()])

      const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

      expect(getAListOfProjectEmployeesMock).toHaveBeenCalledTimes(1)
      expect(result.employeesDetached).toEqual([9])
    })

    it("falls back to a single search (with includes:employees) without prefetch", async () => {
      searchForProjectsMock.mockResolvedValue({ data: [matchingRow({ employees: [{ id: 4 }] })] })
      const upserter = makeUpserter()

      const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [4] })

      expect(searchForProjectsMock.mock.calls[0][0]).toMatchObject({
        body: {
          scopes: [{ name: "byNumber", parameters: ["proj-1"] }],
          includes: [{ relation: "employees" }],
        },
      })
      expect(getAListOfProjectEmployeesMock).not.toHaveBeenCalled()
      expect(result.status).toBe("unchanged")
    })

    it("keeps ambiguity visible instead of silently taking the first row", async () => {
      const warn = vi.spyOn(silentLog, "warn").mockImplementation(() => undefined)
      const upserter = makePrefetchedUpserter([matchingRow(), matchingRow({ id: 56 })])

      const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

      expect(result.clockinProjectId).toBe(55)
      expect(warn).toHaveBeenCalledWith(
        "multiple clockin projects share one dimacon number",
        expect.objectContaining({ clockinProjectIds: [55, 56] }),
      )
      warn.mockRestore()
    })
  })

  it("unarchives with a bare body (no number!) when the project step is off", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [matchingRow({ archived: true })] })
    const upserter = makeUpserter({ steps: { projects: false } })

    const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [] })

    expect(result.status).toBe("updated")
    expect(updateProjectMock).toHaveBeenCalledTimes(1)
    expect(updateProjectMock.mock.calls[0][0]).toEqual({
      client: stubClient,
      path: { project: 55 },
      body: { name: "Baustelle Nord", archived: false },
    })
  })

  it("skips a missing project without creating when the project step is off", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [] })
    const onResolved = vi.fn()
    const upserter = makeUpserter({ steps: { projects: false }, onResolved })

    const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [2] })

    expect(result.status).toBe("skipped")
    expect(result.clockinProjectId).toBeUndefined()
    expect(createProjectMock).not.toHaveBeenCalled()
    expect(onResolved).not.toHaveBeenCalled()
  })

  it("skips creation with a reason when the customer is unresolved (customer step off)", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [] })
    const upserter = makeUpserter({ steps: { customers: false } })

    const result = await upserter.upsert({ date, project, customer: null, desiredEmployeeIds: [] })

    expect(result.status).toBe("skipped")
    expect(result.reason).toBe("Kunde in Clockin nicht aufgelöst — Projekt nicht angelegt")
    expect(createProjectMock).not.toHaveBeenCalled()
  })

  it("attaches and detaches the employee delta", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [matchingRow()] })
    getAListOfProjectEmployeesMock.mockResolvedValue({ data: [{ id: 1 }, { id: 2 }] })
    const upserter = makeUpserter()

    const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [2, 3] })

    expect(result.status).toBe("updated")
    expect(result.employeesAttached).toEqual([3])
    expect(result.employeesDetached).toEqual([1])
    expect(attachEmployeesMock.mock.calls[0][0]).toMatchObject({
      path: { project: 55 },
      body: { resources: [3] },
    })
    expect(detachEmployeesMock.mock.calls[0][0]).toMatchObject({
      path: { project: 55 },
      body: { resources: [1] },
    })
    expect(updateProjectMock).not.toHaveBeenCalled()
  })

  it("never reads project employees when the assignments step is off", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [matchingRow()] })
    const upserter = makeUpserter({ steps: { assignments: false } })

    const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [2, 3] })

    expect(result.status).toBe("unchanged")
    expect(getAListOfProjectEmployeesMock).not.toHaveBeenCalled()
    expect(attachEmployeesMock).not.toHaveBeenCalled()
    expect(detachEmployeesMock).not.toHaveBeenCalled()
  })

  it("fails without onResolved when createProject returns no id", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [] })
    createProjectMock.mockResolvedValue({ data: {} })
    const onResolved = vi.fn()
    const upserter = makeUpserter({ onResolved })

    const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [2] })

    expect(result.status).toBe("failed")
    expect(result.reason).toBe("clockin createProject returned no id")
    expect(onResolved).not.toHaveBeenCalled()
    expect(attachEmployeesMock).not.toHaveBeenCalled()
  })

  it("reports the created id via onResolved even when attachEmployees fails", async () => {
    // Die Archiv-Phase darf frisch angelegte Projekte nie archivieren —
    // onResolved muss deshalb VOR dem attach passieren.
    searchForProjectsMock.mockResolvedValue({ data: [] })
    createProjectMock.mockResolvedValue({ data: { id: 99 } })
    attachEmployeesMock.mockRejectedValue(new Error("boom"))
    const onResolved = vi.fn()
    const upserter = makeUpserter({ onResolved })

    await expect(
      upserter.upsert({ date, project, customer, desiredEmployeeIds: [2] }),
    ).rejects.toThrow("boom")

    expect(onResolved).toHaveBeenCalledWith(99)
  })

  it("performs no writes in dryRun mode on the create path", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [] })
    const upserter = makeUpserter({ dryRun: true })

    const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [2] })

    expect(result.status).toBe("created")
    expectNoWrites()
  })

  it("performs no writes in dryRun mode on the update path", async () => {
    searchForProjectsMock.mockResolvedValue({ data: [matchingRow({ archived: true })] })
    getAListOfProjectEmployeesMock.mockResolvedValue({ data: [{ id: 1 }] })
    const upserter = makeUpserter({ dryRun: true })

    const result = await upserter.upsert({ date, project, customer, desiredEmployeeIds: [2] })

    expect(result.status).toBe("updated")
    expect(result.employeesAttached).toEqual([2])
    expect(result.employeesDetached).toEqual([1])
    expectNoWrites()
  })
})
