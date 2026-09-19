import { describe, expect, it } from "vitest"
import { FIELD_CATALOG } from "./field-catalog.js"
import {
  applyMapping,
  coerceToAttribute,
  coerceValue,
  diffMappedFields,
  EMPTY_DISCOVERY,
  validateRules,
} from "./field-mapping.js"
import type { Discovery, SourceValues } from "./field-mapping.js"

const projectValues: SourceValues = {
  standard: {
    name: "Musterprojekt",
    street: "Projektstraße 6",
    zipCity: "80331 München",
    "zipCity.zip": "80331",
    "zipCity.city": "München",
  },
  attributes: new Map(),
}

const discovery: Discovery = {
  attributes: [
    { id: "attr-str", label: "Notiz", type: "STRING", isActive: true },
    { id: "attr-num", label: "Fläche", type: "NUMBER", isActive: true },
    { id: "attr-switch", label: "Freigabe", type: "SWITCH", isActive: true },
    {
      id: "attr-select",
      label: "Kategorie",
      type: "SELECT",
      enumDefinitionId: "enum-1",
      isActive: true,
    },
    {
      id: "attr-multi",
      label: "Gewerke",
      type: "MULTI_SELECT",
      enumDefinitionId: "enum-1",
      isActive: true,
    },
    { id: "attr-date", label: "Abnahme", type: "DATE", isActive: true },
  ],
  enums: new Map([
    [
      "enum-1",
      {
        id: "enum-1",
        name: "Kategorien",
        values: [
          { id: "v1", value: "Neubau", isActive: true },
          { id: "v2", value: "Sanierung", isActive: true },
        ],
      },
    ],
  ]),
  customFields: [
    { id: 11, label: "Notizfeld", dataType: "text" },
    { id: 12, label: "Zahlenfeld", dataType: "number" },
    { id: 13, label: "Datumsfeld", dataType: "date" },
  ],
  targetAttributes: [],
}

describe("applyMapping — Default-Regeln reproduzieren das Legacy-Verhalten", () => {
  it("project defaults produce the exact legacy body fields", () => {
    const applied = applyMapping(
      FIELD_CATALOG.project.defaultRules,
      FIELD_CATALOG.project,
      EMPTY_DISCOVERY,
      projectValues,
    )
    expect(applied.standardFields).toEqual({
      name: "Musterprojekt",
      destination_street: "Projektstraße 6",
      destination_zip: "80331",
      destination_city: "München",
    })
    expect(applied.customFields).toEqual([])
    expect(applied.warnings).toEqual([])
  })

  it("project defaults write null for empty sources (overwrite semantics)", () => {
    const applied = applyMapping(
      FIELD_CATALOG.project.defaultRules,
      FIELD_CATALOG.project,
      EMPTY_DISCOVERY,
      {
        standard: { name: "P", street: "", "zipCity.zip": "", "zipCity.city": "" },
        attributes: new Map(),
      },
    )
    expect(applied.standardFields).toEqual({
      name: "P",
      destination_street: null,
      destination_zip: null,
      destination_city: null,
    })
  })

  it("customer defaults produce the exact legacy body fields", () => {
    const applied = applyMapping(
      FIELD_CATALOG.customer.defaultRules,
      FIELD_CATALOG.customer,
      EMPTY_DISCOVERY,
      {
        standard: {
          name: "Muster GmbH",
          street: "Musterweg 1",
          "zipCity.zip": "80331",
          "zipCity.city": "München",
        },
        attributes: new Map(),
      },
    )
    expect(applied.standardFields).toEqual({
      company: "Muster GmbH",
      street: "Musterweg 1",
      zip: "80331",
      city: "München",
    })
  })

  it("employee defaults omit empty phone (fillIfNonEmpty semantics)", () => {
    const withPhone = applyMapping(
      FIELD_CATALOG.employee.defaultRules,
      FIELD_CATALOG.employee,
      EMPTY_DISCOVERY,
      { standard: { phoneNumber: "0151 123" }, attributes: new Map() },
    )
    expect(withPhone.standardFields).toEqual({ phone_work: "0151 123" })

    const withoutPhone = applyMapping(
      FIELD_CATALOG.employee.defaultRules,
      FIELD_CATALOG.employee,
      EMPTY_DISCOVERY,
      { standard: { phoneNumber: "" }, attributes: new Map() },
    )
    expect(withoutPhone.standardFields).toEqual({})
  })
})

describe("applyMapping — Attribute und Custom-Fields", () => {
  it("maps an attribute onto a custom field", () => {
    const applied = applyMapping(
      [
        {
          source: { kind: "attribute", attributeId: "attr-str" },
          target: { kind: "custom", customFieldId: 11 },
        },
      ],
      FIELD_CATALOG.project,
      discovery,
      { standard: {}, attributes: new Map([["attr-str", "Hallo"]]) },
    )
    expect(applied.customFields).toEqual([{ custom_field_id: 11, value: "Hallo" }])
  })

  it("skips unknown attributes and custom fields with warnings", () => {
    const applied = applyMapping(
      [
        {
          source: { kind: "attribute", attributeId: "gone" },
          target: { kind: "custom", customFieldId: 11 },
        },
        {
          source: { kind: "standard", field: "name" },
          target: { kind: "custom", customFieldId: 999 },
        },
      ],
      FIELD_CATALOG.project,
      discovery,
      projectValues,
    )
    expect(applied.customFields).toEqual([])
    expect(applied.warnings.map((w) => w.code)).toEqual([
      "unknown_attribute",
      "unknown_custom_field",
    ])
  })

  it("clears a custom field with an empty string when the source is empty (overwrite)", () => {
    const applied = applyMapping(
      [
        {
          source: { kind: "attribute", attributeId: "attr-str" },
          target: { kind: "custom", customFieldId: 11 },
        },
      ],
      FIELD_CATALOG.project,
      discovery,
      { standard: {}, attributes: new Map([["attr-str", ""]]) },
    )
    expect(applied.customFields).toEqual([{ custom_field_id: 11, value: "" }])

    const employee = applyMapping(
      [
        {
          source: { kind: "standard", field: "phoneNumber" },
          target: { kind: "custom", customFieldId: 11 },
        },
      ],
      FIELD_CATALOG.employee,
      discovery,
      { standard: { phoneNumber: "" }, attributes: new Map() },
    )
    // fillIfNonEmpty: leere Quelle lässt das Custom-Field unangetastet
    expect(employee.customFields).toEqual([])
  })

  it("flags a non-numeric value on a number custom field as type_mismatch", () => {
    const applied = applyMapping(
      [
        {
          source: { kind: "attribute", attributeId: "attr-str" },
          target: { kind: "custom", customFieldId: 12 },
        },
      ],
      FIELD_CATALOG.project,
      discovery,
      { standard: {}, attributes: new Map([["attr-str", "keine zahl"]]) },
    )
    expect(applied.customFields).toEqual([])
    expect(applied.warnings[0]?.code).toBe("type_mismatch")
  })
})

describe("coerceValue", () => {
  const enumDef = discovery.enums.get("enum-1")

  it("coerces SWITCH to true/false text", () => {
    expect(coerceValue("SWITCH", "true", "text")).toBe("true")
    expect(coerceValue("SWITCH", "1", "text")).toBe("true")
    expect(coerceValue("SWITCH", "false", "text")).toBe("false")
  })

  it("resolves SELECT enum ids to labels, passes through unknown values", () => {
    expect(coerceValue("SELECT", "v1", "text", enumDef)).toBe("Neubau")
    expect(coerceValue("SELECT", "Bestand", "text", enumDef)).toBe("Bestand")
  })

  it("joins MULTI_SELECT values", () => {
    expect(coerceValue("MULTI_SELECT", '["v1","v2"]', "text", enumDef)).toBe("Neubau, Sanierung")
    expect(coerceValue("MULTI_SELECT", "v1, v2", "text", enumDef)).toBe("Neubau, Sanierung")
  })

  it("truncates DATE to the date part and validates date targets", () => {
    expect(coerceValue("DATE", "2026-08-14T05:00:00", "text")).toBe("2026-08-14")
    expect(coerceValue("STRING", "2026-08-14T05:00:00", "date")).toBe("2026-08-14")
    expect(coerceValue("STRING", "kein datum", "date")).toBeNull()
  })

  it("normalizes NUMBER and rejects non-numeric for number targets", () => {
    expect(coerceValue("NUMBER", "1,5", "number")).toBe("1.5")
    expect(coerceValue("STRING", "abc", "number")).toBeNull()
  })

  it("returns undefined for empty values", () => {
    expect(coerceValue("STRING", "", "text")).toBeUndefined()
    expect(coerceValue("STRING", undefined, "text")).toBeUndefined()
  })
})

/** Übernahme Lexware → Dimacon: Dimacon-Kunden-Attribute als ZIELE. */
const reverseDiscovery: Discovery = {
  ...EMPTY_DISCOVERY,
  targetAttributes: [
    { id: "t-str", label: "USt-IdNr.", type: "STRING", isActive: true },
    { id: "t-num", label: "Kundenrabatt", type: "NUMBER", isActive: true },
    { id: "t-sel", label: "Kategorie", type: "SELECT", enumDefinitionId: "e", isActive: true },
    { id: "t-off", label: "Alt", type: "STRING", isActive: false },
  ],
}

const lexwareValues: SourceValues = {
  standard: {
    note: "Stammkunde",
    vatRegistrationId: "DE1",
    customerNumber: "10010",
    taxNumber: "",
  },
  attributes: new Map(),
}

function toAttribute(field: string, attributeId: string) {
  return {
    source: { kind: "standard" as const, field },
    target: { kind: "attribute" as const, attributeId },
  }
}

describe("applyMapping — Dimacon-Attribute als Ziel", () => {
  it("writes coerced values into attributeValues and omits empty sources", () => {
    const applied = applyMapping(
      [toAttribute("vatRegistrationId", "t-str"), toAttribute("taxNumber", "t-num")],
      FIELD_CATALOG.dimaconCustomer,
      reverseDiscovery,
      lexwareValues,
    )
    expect(applied.attributeValues).toEqual([{ attributeId: "t-str", value: "DE1" }])
    expect(applied.warnings).toEqual([])
  })

  it("warns instead of writing a value that does not fit the attribute type", () => {
    const applied = applyMapping(
      [toAttribute("note", "t-num")],
      FIELD_CATALOG.dimaconCustomer,
      reverseDiscovery,
      lexwareValues,
    )
    expect(applied.attributeValues).toEqual([])
    expect(applied.warnings[0]?.code).toBe("type_mismatch")
  })

  it.each([
    ["t-sel", "nicht befüllt"],
    ["t-off", "deaktiviert"],
    ["t-gone", "existiert nicht mehr"],
  ])("never writes attribute %s", (attributeId, message) => {
    const applied = applyMapping(
      [toAttribute("note", attributeId)],
      FIELD_CATALOG.dimaconCustomer,
      reverseDiscovery,
      lexwareValues,
    )
    expect(applied.attributeValues).toEqual([])
    expect(applied.warnings[0]?.message).toContain(message)
  })
})

describe("coerceToAttribute", () => {
  it.each([
    ["STRING", "  frei  ", "frei"],
    ["NUMBER", "12,5", "12.5"],
    ["NUMBER", "zwölf", null],
    ["DATE", "2026-09-19T10:00", "2026-09-19"],
    ["DATE", "1.9.2026", "2026-09-01"],
    ["DATE", "morgen", null],
    ["SWITCH", "Ja", "true"],
    ["SWITCH", "0", "false"],
    ["SWITCH", "vielleicht", null],
    ["SELECT", "Neubau", null],
  ] as const)("%s ← %j", (type, raw, expected) => {
    expect(coerceToAttribute(raw, type)).toBe(expected)
  })

  it("treats an empty source as missing, not as invalid", () => {
    expect(coerceToAttribute("  ", "NUMBER")).toBeUndefined()
  })
})

describe("diffMappedFields", () => {
  it("treats empty string, null and undefined as equal", () => {
    const diff = diffMappedFields(
      {
        standardFields: { description: null },
        customFields: [],
        attributeValues: [],
        warnings: [],
      },
      { standard: { description: "" }, customFields: new Map() },
    )
    expect(diff.changed).toBe(false)
  })

  it("detects standard and custom field changes", () => {
    const diff = diffMappedFields(
      {
        standardFields: { name: "Neu" },
        customFields: [{ custom_field_id: 11, value: "A" }],
        attributeValues: [],
        warnings: [],
      },
      { standard: { name: "Alt" }, customFields: new Map([[11, "B"]]) },
    )
    expect(diff.changed).toBe(true)
    expect(diff.changes).toEqual(["name", "custom:11"])
  })
})

describe("validateRules", () => {
  it("accepts the default rules", () => {
    for (const entity of [
      "project",
      "customer",
      "employee",
      "lexofficeContact",
      "dimaconCustomer",
    ] as const) {
      const res = validateRules(
        FIELD_CATALOG[entity].defaultRules,
        FIELD_CATALOG[entity],
        discovery,
      )
      expect(res).toEqual({ ok: true })
    }
  })

  it("rejects custom targets for entities without custom fields", () => {
    const res = validateRules(
      [
        {
          source: { kind: "standard", field: "street" },
          target: { kind: "standard", field: "addresses.billing.street" },
        },
        {
          source: { kind: "standard", field: "name" },
          target: { kind: "custom", customFieldId: 1 },
        },
      ],
      FIELD_CATALOG.lexofficeContact,
      EMPTY_DISCOVERY,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("Custom-Ziele werden für diese Entität")
  })

  it("validates attribute targets against the dimacon customer attributes", () => {
    const ok = validateRules(
      [toAttribute("vatRegistrationId", "t-str")],
      FIELD_CATALOG.dimaconCustomer,
      reverseDiscovery,
    )
    expect(ok).toEqual({ ok: true })

    const res = validateRules(
      [toAttribute("note", "t-sel"), toAttribute("note", "t-off"), toAttribute("note", "t-gone")],
      FIELD_CATALOG.dimaconCustomer,
      reverseDiscovery,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors.join()).toContain("(SELECT) kann nicht befüllt werden")
      expect(res.errors.join()).toContain("deaktiviert")
      expect(res.errors.join()).toContain("unbekanntes Dimacon-Attribut t-gone")
    }
  })

  it("rejects attribute targets for entities that write elsewhere", () => {
    const res = validateRules(
      [
        {
          source: { kind: "standard", field: "name" },
          target: { kind: "attribute", attributeId: "t-str" },
        },
      ],
      FIELD_CATALOG.customer,
      discovery,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("Attribut-Ziele werden für diese Entität")
  })

  it("rejects the locked match keys of the dimacon customer", () => {
    const res = validateRules(
      [
        {
          source: { kind: "standard", field: "note" },
          target: { kind: "standard", field: "customerNumber" },
        },
      ],
      FIELD_CATALOG.dimaconCustomer,
      reverseDiscovery,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("fixiert")
  })

  it("rejects the locked company.name target for lexoffice contacts", () => {
    const res = validateRules(
      [
        {
          source: { kind: "standard", field: "description" },
          target: { kind: "standard", field: "company.name" },
        },
      ],
      FIELD_CATALOG.lexofficeContact,
      EMPTY_DISCOVERY,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("fixiert")
  })

  it("rejects duplicate targets", () => {
    const res = validateRules(
      [
        {
          source: { kind: "standard", field: "name" },
          target: { kind: "standard", field: "name" },
        },
        {
          source: { kind: "standard", field: "street" },
          target: { kind: "standard", field: "name" },
        },
      ],
      FIELD_CATALOG.project,
      discovery,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("doppelt")
  })

  it("rejects locked targets", () => {
    const res = validateRules(
      [
        {
          source: { kind: "standard", field: "name" },
          target: { kind: "standard", field: "name" },
        },
        {
          source: { kind: "standard", field: "name" },
          target: { kind: "standard", field: "number" },
        },
      ],
      FIELD_CATALOG.project,
      discovery,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("fixiert")
  })

  it("requires the required targets", () => {
    const res = validateRules([], FIELD_CATALOG.project, discovery)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain('Pflicht-Ziel "name"')
  })

  it("rejects unknown attribute and custom field references", () => {
    const res = validateRules(
      [
        {
          source: { kind: "standard", field: "name" },
          target: { kind: "standard", field: "name" },
        },
        {
          source: { kind: "attribute", attributeId: "gone" },
          target: { kind: "custom", customFieldId: 999 },
        },
      ],
      FIELD_CATALOG.project,
      discovery,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors.join()).toContain("unbekanntes Dimacon-Attribut")
      expect(res.errors.join()).toContain("unbekanntes Clockin-Custom-Field")
    }
  })
})
