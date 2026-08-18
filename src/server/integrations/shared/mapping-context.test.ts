import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MappingRule } from "./field-mapping-schema.js"

const getAllAttributesMock = vi.fn()
const getAllAttributes2Mock = vi.fn()
const getAllEnums1Mock = vi.fn()
const getProjectCustomFieldsMock = vi.fn()
const getCustomerCustomFieldsMock = vi.fn()
const getEmployeeCustomFieldsMock = vi.fn()
const getFieldMappingMock = vi.fn()

vi.mock("@miragon/client-dimacon", () => ({
  sdk: {
    getAllAttributes: getAllAttributesMock,
    getAllAttributes2: getAllAttributes2Mock,
    getAllEnums1: getAllEnums1Mock,
  },
}))

vi.mock("@miragon/client-clockin", () => ({
  sdk: {
    getProjectCustomFields: getProjectCustomFieldsMock,
    getCustomerCustomFields: getCustomerCustomFieldsMock,
    getEmployeeCustomFields: getEmployeeCustomFieldsMock,
  },
}))

vi.mock("../../lib/settings.js", () => ({
  getFieldMapping: getFieldMappingMock,
}))

const { loadDiscovery, loadMappingContext } = await import("./mapping-context.js")
const { FIELD_CATALOG } = await import("./field-catalog.js")
const { EMPTY_DISCOVERY } = await import("./field-mapping.js")

const dimaconClient = {} as never
const clockinStub = {} as never

/** Getter, der bei versehentlicher Konstruktion sofort auffliegt (dimacon-lexoffice-Szenario). */
function throwingClockinGetter() {
  return vi.fn((): never => {
    throw new Error("Clockin-Client darf hier nicht konstruiert werden")
  })
}

function expectNoSdkCalls() {
  expect(getAllAttributesMock).not.toHaveBeenCalled()
  expect(getAllAttributes2Mock).not.toHaveBeenCalled()
  expect(getAllEnums1Mock).not.toHaveBeenCalled()
  expect(getProjectCustomFieldsMock).not.toHaveBeenCalled()
  expect(getCustomerCustomFieldsMock).not.toHaveBeenCalled()
  expect(getEmployeeCustomFieldsMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  getAllAttributesMock.mockReset()
  getAllAttributes2Mock.mockReset()
  getAllEnums1Mock.mockReset()
  getProjectCustomFieldsMock.mockReset()
  getCustomerCustomFieldsMock.mockReset()
  getEmployeeCustomFieldsMock.mockReset()
  getFieldMappingMock.mockReset()
})

describe("loadMappingContext (Regeln + Discovery pro Entity)", () => {
  it("falls back to default rules without any sdk calls when nothing is persisted", async () => {
    getFieldMappingMock.mockResolvedValue(undefined)
    const getClockin = throwingClockinGetter()

    const context = await loadMappingContext(dimaconClient, getClockin, "dimacon-clockin", [
      "project",
      "customer",
    ])

    for (const entity of ["project", "customer"] as const) {
      const ctx = context.get(entity)
      expect(ctx).toBeDefined()
      expect(ctx?.rules).toBe(FIELD_CATALOG[entity].defaultRules)
      expect(ctx?.discovery).toBe(EMPTY_DISCOVERY)
      expect(ctx?.isCustomized).toBe(false)
      expect(ctx?.hasCustomTargets).toBe(false)
    }
    expectNoSdkCalls()
    expect(getClockin).not.toHaveBeenCalled()
  })

  it("marks persisted standard-only rules as customized without discovery calls", async () => {
    const rules: MappingRule[] = [
      {
        source: { kind: "standard", field: "name" },
        target: { kind: "standard", field: "company" },
      },
    ]
    getFieldMappingMock.mockResolvedValue({ version: 1, rules })
    const getClockin = throwingClockinGetter()

    const context = await loadMappingContext(dimaconClient, getClockin, "dimacon-clockin", [
      "customer",
    ])

    const ctx = context.get("customer")
    expect(ctx?.isCustomized).toBe(true)
    expect(ctx?.hasCustomTargets).toBe(false)
    expect(ctx?.rules).toEqual(rules)
    expect(ctx?.discovery).toBe(EMPTY_DISCOVERY)
    expectNoSdkCalls()
    expect(getClockin).not.toHaveBeenCalled()
  })

  it("fetches project attributes (getAllAttributes) for an attribute-source rule", async () => {
    const rules: MappingRule[] = [
      {
        source: { kind: "attribute", attributeId: "attr-1" },
        target: { kind: "standard", field: "department" },
      },
    ]
    getFieldMappingMock.mockResolvedValue({ version: 1, rules })
    getAllAttributesMock.mockResolvedValue([
      { id: "attr-1", label: "Abteilung", type: "STRING", isActive: true },
    ])
    getProjectCustomFieldsMock.mockResolvedValue({ data: [] })

    const context = await loadMappingContext(dimaconClient, () => clockinStub, "dimacon-clockin", [
      "project",
    ])

    expect(getAllAttributesMock).toHaveBeenCalledTimes(1)
    expect(getAllAttributes2Mock).not.toHaveBeenCalled()
    // STRING-Attribut → keine Enum-Definitionen nötig
    expect(getAllEnums1Mock).not.toHaveBeenCalled()
    expect(context.get("project")?.discovery.attributes).toEqual([
      {
        id: "attr-1",
        label: "Abteilung",
        type: "STRING",
        enumDefinitionId: undefined,
        isActive: true,
      },
    ])
  })

  it("fetches customer attributes (getAllAttributes2) and enums for a SELECT attribute", async () => {
    const rules: MappingRule[] = [
      {
        source: { kind: "attribute", attributeId: "attr-sel" },
        target: { kind: "standard", field: "description" },
      },
    ]
    getFieldMappingMock.mockResolvedValue({ version: 1, rules })
    getAllAttributes2Mock.mockResolvedValue([
      {
        id: "attr-sel",
        label: "Kategorie",
        type: "SELECT",
        enumDefinitionId: "enum-1",
        isActive: true,
      },
    ])
    getAllEnums1Mock.mockResolvedValue([
      { id: "enum-1", name: "Kategorien", values: [{ id: "v1", value: "A", isActive: true }] },
    ])
    getCustomerCustomFieldsMock.mockResolvedValue({ data: [] })

    const context = await loadMappingContext(dimaconClient, () => clockinStub, "dimacon-clockin", [
      "customer",
    ])

    expect(getAllAttributes2Mock).toHaveBeenCalledTimes(1)
    expect(getAllAttributesMock).not.toHaveBeenCalled()
    expect(getAllEnums1Mock).toHaveBeenCalledTimes(1)
    expect(context.get("customer")?.discovery.enums.get("enum-1")).toEqual({
      id: "enum-1",
      name: "Kategorien",
      values: [{ id: "v1", value: "A", isActive: true }],
    })
  })

  it("fetches employee custom fields for a custom target and flags hasCustomTargets", async () => {
    const rules: MappingRule[] = [
      {
        source: { kind: "standard", field: "phoneNumber" },
        target: { kind: "custom", customFieldId: 5 },
      },
    ]
    getFieldMappingMock.mockResolvedValue({ version: 1, rules })
    getEmployeeCustomFieldsMock.mockResolvedValue({
      data: [{ id: 5, label: "Handy", data_type: "text" }, { label: "ohne id" }],
    })
    const getClockin = vi.fn(() => clockinStub)

    const context = await loadMappingContext(dimaconClient, getClockin, "dimacon-clockin", [
      "employee",
    ])

    const ctx = context.get("employee")
    expect(ctx?.isCustomized).toBe(true)
    expect(ctx?.hasCustomTargets).toBe(true)
    expect(getClockin).toHaveBeenCalledTimes(1)
    expect(getEmployeeCustomFieldsMock).toHaveBeenCalledTimes(1)
    // Zeilen ohne id werden verworfen, data_type wird auf dataType gemappt
    expect(ctx?.discovery.customFields).toEqual([{ id: 5, label: "Handy", dataType: "text" }])
    // Dimacon kennt keine Mitarbeiter-Attribute → keine Attribut-/Enum-Calls
    expect(getAllAttributesMock).not.toHaveBeenCalled()
    expect(getAllAttributes2Mock).not.toHaveBeenCalled()
    expect(getAllEnums1Mock).not.toHaveBeenCalled()
  })

  it("reads customer attributes for lexofficeContact without constructing a clockin client", async () => {
    const rules: MappingRule[] = [
      {
        source: { kind: "attribute", attributeId: "attr-1" },
        target: { kind: "standard", field: "note" },
      },
    ]
    getFieldMappingMock.mockResolvedValue({ version: 1, rules })
    getAllAttributes2Mock.mockResolvedValue([
      { id: "attr-1", label: "Notiz", type: "STRING", isActive: true },
    ])
    const getClockin = throwingClockinGetter()

    const context = await loadMappingContext(dimaconClient, getClockin, "dimacon-lexoffice", [
      "lexofficeContact",
    ])

    expect(getAllAttributes2Mock).toHaveBeenCalledTimes(1)
    expect(getClockin).not.toHaveBeenCalled()
    expect(getProjectCustomFieldsMock).not.toHaveBeenCalled()
    expect(getCustomerCustomFieldsMock).not.toHaveBeenCalled()
    expect(getEmployeeCustomFieldsMock).not.toHaveBeenCalled()
    expect(context.get("lexofficeContact")?.discovery.customFields).toEqual([])
  })
})

describe("loadDiscovery (Editor-Discovery)", () => {
  it("keeps inactive attributes only when a rule references them", async () => {
    getAllAttributes2Mock.mockResolvedValue([
      { id: "attr-active", label: "Aktiv", type: "STRING", isActive: true },
      { id: "attr-ref", label: "Inaktiv, referenziert", type: "STRING", isActive: false },
      { id: "attr-old", label: "Inaktiv, unreferenziert", type: "STRING", isActive: false },
    ])
    getCustomerCustomFieldsMock.mockResolvedValue({ data: [] })
    const rules: MappingRule[] = [
      {
        source: { kind: "attribute", attributeId: "attr-ref" },
        target: { kind: "standard", field: "description" },
      },
    ]

    const discovery = await loadDiscovery(dimaconClient, () => clockinStub, "customer", rules)

    expect(discovery.attributes.map((a) => a.id)).toEqual(["attr-active", "attr-ref"])
  })
})
