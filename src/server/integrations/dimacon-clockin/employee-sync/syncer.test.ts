import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import type { EntityMappingContext } from "../../shared/mapping-context.js"
import type { EmployeePair } from "./matcher.js"
import type { ClockinEmployeeInfo } from "./types.js"

const clockinCreateEmployeeMock = vi.fn()
const clockinUpdateEmployeeMock = vi.fn()
const dimaconCreateEmployeeMock = vi.fn()
const dimaconUpdateEmployeeMock = vi.fn()

vi.mock("@miragon/client-clockin", () => ({
  sdk: { createEmployee: clockinCreateEmployeeMock, updateEmployee: clockinUpdateEmployeeMock },
}))
vi.mock("@miragon/client-dimacon", () => ({
  sdk: { createNewEmployee: dimaconCreateEmployeeMock, updateEmployee: dimaconUpdateEmployeeMock },
}))

const { EmployeeSyncer } = await import("./syncer.js")
const { FIELD_CATALOG } = await import("../../shared/field-catalog.js")
const { EMPTY_DISCOVERY } = await import("../../shared/field-mapping.js")
const { log } = await import("../../../lib/log.js")

const silentLog = log.child({ test: true })
;(silentLog as unknown as { info: () => void }).info = () => {
  /* swallow */
}

const stubDimaconClient = {} as never
const stubClockinClient = {} as never

// Default-Regeln + leere Discovery ≙ Verhalten ohne persistierte Zuordnung
const employeeMapping: EntityMappingContext = {
  entity: "employee",
  rules: FIELD_CATALOG.employee.defaultRules,
  catalog: FIELD_CATALOG.employee,
  discovery: EMPTY_DISCOVERY,
  isCustomized: false,
  hasCustomTargets: false,
}

function dim(overrides: Partial<DimaconEmployeeFull> = {}): DimaconEmployeeFull {
  return {
    id: "d1",
    firstName: "Anna",
    lastName: "Muster",
    role: "CRAFTSMAN",
    color: "#A1A1AA",
    timeTrackingActive: true,
    isArchived: false,
    ...overrides,
  }
}

function clk(overrides: Partial<ClockinEmployeeInfo> = {}): ClockinEmployeeInfo {
  return {
    id: 1,
    firstName: "Anna",
    lastName: "Muster",
    ...overrides,
  }
}

function pair(d: DimaconEmployeeFull, c: ClockinEmployeeInfo): EmployeePair {
  return { dimacon: d, clockin: c, matchedBy: "name" }
}

function syncer(dryRun = false): InstanceType<typeof EmployeeSyncer> {
  return new EmployeeSyncer(
    stubDimaconClient,
    stubClockinClient,
    silentLog,
    dryRun,
    employeeMapping,
  )
}

beforeEach(() => {
  clockinCreateEmployeeMock.mockReset().mockResolvedValue({ data: { id: 55 } })
  clockinUpdateEmployeeMock.mockReset().mockResolvedValue({})
  dimaconCreateEmployeeMock.mockReset().mockResolvedValue({ id: "d-new" })
  dimaconUpdateEmployeeMock.mockReset().mockResolvedValue({})
})

describe("EmployeeSyncer.alignPair", () => {
  it("reports unchanged for an equal pair without any writes", async () => {
    const row = await syncer().alignPair(
      pair(
        dim({ personnelNumber: "P-1", phoneNumber: "0151 123" }),
        clk({ personnelNumber: "P-1", phoneWork: "0151 123" }),
      ),
    )

    expect(row.status).toBe("unchanged")
    expect(clockinCreateEmployeeMock).not.toHaveBeenCalled()
    expect(clockinUpdateEmployeeMock).not.toHaveBeenCalled()
    expect(dimaconCreateEmployeeMock).not.toHaveBeenCalled()
    expect(dimaconUpdateEmployeeMock).not.toHaveBeenCalled()
  })

  it("pushes name drift to clockin with a dimacon-first body", async () => {
    const row = await syncer().alignPair(
      pair(
        dim({ firstName: "Anna-Lena", personnelNumber: "P-1", phoneNumber: "0151 123" }),
        clk({
          email: "anna@clockin.example",
          personnelNumber: "P-2",
          phoneWork: "0151 999",
          raw: { phone_work: "0151 999" },
        }),
      ),
    )

    expect(row.status).toBe("updated")
    expect(clockinUpdateEmployeeMock).toHaveBeenCalledTimes(1)
    expect(clockinUpdateEmployeeMock.mock.calls[0][0]).toMatchObject({ path: { employee: 1 } })
    // E-Mail bleibt der Clockin-Wert, Personalnummer gewinnt Dimacon,
    // phone_work kommt aus dem Mapping-Spread (Dimacon-Telefon nicht leer)
    expect(clockinUpdateEmployeeMock.mock.calls[0][0].body).toEqual({
      phone_work: "0151 123",
      first_name: "Anna-Lena",
      last_name: "Muster",
      email: "anna@clockin.example",
      personnel_number: "P-1",
    })
    expect(dimaconUpdateEmployeeMock).not.toHaveBeenCalled()
  })

  it("falls back for the personnel number dimacon → clockin → undefined", async () => {
    // Dimacon ohne Personalnummer → Clockin-Wert bleibt im Body erhalten
    await syncer().alignPair(pair(dim({ firstName: "Anna-Lena" }), clk({ personnelNumber: "P-2" })))
    expect(clockinUpdateEmployeeMock.mock.calls[0][0].body.personnel_number).toBe("P-2")

    clockinUpdateEmployeeMock.mockClear()

    // beide Seiten leer → personnel_number undefined, E-Mail null,
    // phone_work fehlt komplett (fillIfNonEmpty bei leerem Dimacon-Telefon)
    await syncer().alignPair(pair(dim({ firstName: "Anna-Lena" }), clk()))
    const body = clockinUpdateEmployeeMock.mock.calls[0][0].body as Record<string, unknown>
    expect(body).toEqual({
      first_name: "Anna-Lena",
      last_name: "Muster",
      email: null,
      personnel_number: undefined,
    })
    expect("phone_work" in body).toBe(false)
  })

  it("updates on a mapped-only change when c.raw is missing (phoneWork fallback)", async () => {
    const row = await syncer().alignPair(
      pair(dim({ phoneNumber: "0151 123" }), clk({ phoneWork: "0151 999" })),
    )

    expect(row.status).toBe("updated")
    expect(row.reason).toContain("phone_work")
    expect(clockinUpdateEmployeeMock).toHaveBeenCalledTimes(1)
    expect(dimaconUpdateEmployeeMock).not.toHaveBeenCalled()
  })

  it("echoes the full dimacon body when backfilling the personnel number", async () => {
    // Regression-Schutz: das Dimacon-PUT ist ein Voll-Replace — der Body muss
    // alle bestehenden Felder zurückspiegeln, sonst werden sie gelöscht.
    const row = await syncer().alignPair(
      pair(
        dim({
          role: "BACKOFFICE",
          phoneNumber: "0151 123",
          color: "#123456",
          timeTrackingActive: false,
        }),
        clk({ personnelNumber: "P-7", phoneWork: "0151 123" }),
      ),
    )

    expect(row.status).toBe("updated")
    expect(row.reason).toContain("Personalnummer P-7 nach Dimacon übernommen")
    expect(clockinUpdateEmployeeMock).not.toHaveBeenCalled()
    expect(dimaconUpdateEmployeeMock).toHaveBeenCalledTimes(1)
    expect(dimaconUpdateEmployeeMock.mock.calls[0][0]).toMatchObject({
      path: { employeeId: "d1" },
    })
    expect(dimaconUpdateEmployeeMock.mock.calls[0][0].body).toEqual({
      role: "BACKOFFICE",
      firstName: "Anna",
      lastName: "Muster",
      personnelNumber: "P-7",
      phoneNumber: "0151 123",
      color: "#123456",
      timeTrackingActive: false,
    })
  })

  it("only reports archived dimacon employees without touching either side", async () => {
    const row = await syncer().alignPair(
      pair(dim({ isArchived: true, firstName: "Anna-Lena" }), clk({ personnelNumber: "P-7" })),
    )

    expect(row.status).toBe("reported")
    expect(row.reason).toContain("archiviert")
    expect(clockinUpdateEmployeeMock).not.toHaveBeenCalled()
    expect(dimaconUpdateEmployeeMock).not.toHaveBeenCalled()
  })
})

describe("EmployeeSyncer.createInClockin", () => {
  it("builds the create body with locked names, null email and omitted blanks", async () => {
    const row = await syncer().createInClockin(
      dim({ personnelNumber: "   ", phoneNumber: "0151 123" }),
    )

    expect(row).toMatchObject({
      direction: "dimacon→clockin",
      dimaconId: "d1",
      clockinId: 55,
      status: "created",
    })
    expect(clockinCreateEmployeeMock).toHaveBeenCalledTimes(1)
    const body = clockinCreateEmployeeMock.mock.calls[0][0].body as Record<string, unknown>
    expect(body).toEqual({
      phone_work: "0151 123",
      first_name: "Anna",
      last_name: "Muster",
      // Whitespace-Personalnummer wird weggelassen, fehlende E-Mail wird null
      personnel_number: undefined,
      email: null,
    })
    expect(body.personnel_number).toBeUndefined()
    // custom_fields-Key nur wenn nicht leer — Default-Regeln haben keine
    expect("custom_fields" in body).toBe(false)
  })
})

describe("EmployeeSyncer.createInDimacon", () => {
  it("creates with CRAFTSMAN role, default color and active time tracking", async () => {
    const row = await syncer().createInDimacon(
      clk({ personnelNumber: "P-3", phoneWork: "0151 555", email: "anna@clockin.example" }),
    )

    expect(row).toMatchObject({
      direction: "clockin→dimacon",
      dimaconId: "d-new",
      clockinId: 1,
      status: "created",
      reason: "Rolle CRAFTSMAN (Default)",
    })
    expect(dimaconCreateEmployeeMock).toHaveBeenCalledTimes(1)
    expect(dimaconCreateEmployeeMock.mock.calls[0][0].body).toEqual({
      firstName: "Anna",
      lastName: "Muster",
      role: "CRAFTSMAN",
      personnelNumber: "P-3",
      phoneNumber: "0151 555",
      color: "#A1A1AA",
      timeTrackingActive: true,
    })
  })
})

describe("EmployeeSyncer dryRun", () => {
  it("performs no sdk calls for align and both create directions", async () => {
    const dry = syncer(true)

    // Drift + Backfill gleichzeitig — beide Schreibpfade müssen trocken bleiben
    const aligned = await dry.alignPair(
      pair(
        dim({ firstName: "Anna-Lena", phoneNumber: "0151 123" }),
        clk({ personnelNumber: "P-7" }),
      ),
    )
    expect(aligned.status).toBe("updated")
    expect(aligned.reason).toContain("[dryRun]")

    const createdClockin = await dry.createInClockin(dim())
    expect(createdClockin).toMatchObject({ status: "created", reason: "[dryRun]" })

    const createdDimacon = await dry.createInDimacon(clk())
    expect(createdDimacon.status).toBe("created")

    expect(clockinCreateEmployeeMock).not.toHaveBeenCalled()
    expect(clockinUpdateEmployeeMock).not.toHaveBeenCalled()
    expect(dimaconCreateEmployeeMock).not.toHaveBeenCalled()
    expect(dimaconUpdateEmployeeMock).not.toHaveBeenCalled()
  })
})
