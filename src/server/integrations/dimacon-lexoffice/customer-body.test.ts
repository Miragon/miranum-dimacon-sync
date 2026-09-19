import { describe, expect, it } from "vitest"
import { FIELD_CATALOG } from "../shared/field-catalog.js"
import { applyMapping, EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import type { Discovery } from "../shared/field-mapping.js"
import type { MappingRule } from "../shared/field-mapping-schema.js"
import type { LexContact } from "./contact-lookup.js"
import { buildDimaconCustomerBody, lexwareContactSourceValues } from "./customer-body.js"

const catalog = FIELD_CATALOG.dimaconCustomer

const contact: LexContact = {
  id: "lex-1",
  version: 1,
  roles: { customer: { number: 10010 } },
  company: {
    name: "Neu Bau GmbH",
    vatRegistrationId: "DE123456789",
    contactPersons: [
      { firstName: "Erika", lastName: "Neben", emailAddress: "erika@x.de" },
      { firstName: "Max", lastName: "Haupt", primary: true, phoneNumber: "089 1" },
    ],
  },
  addresses: {
    billing: [{ street: "Münchnerstraße 24", zip: "80000", city: "München" }],
    shipping: [{ street: "Lager 1", zip: "1", city: "X" }],
  },
  emailAddresses: { office: ["office@x.de"], business: ["  ", "info@x.de"] },
  phoneNumbers: { mobile: ["0170 1"], fax: ["089 2"] },
  note: "  Bauleistung §13b  ",
}

function build(rules: MappingRule[], discovery: Discovery = EMPTY_DISCOVERY) {
  const applied = applyMapping(rules, catalog, discovery, lexwareContactSourceValues(contact))
  return { applied, body: buildDimaconCustomerBody(applied, "Neu Bau GmbH", "10010") }
}

describe("lexwareContactSourceValues", () => {
  it("offers every catalog source", () => {
    const values = lexwareContactSourceValues(contact)
    for (const source of catalog.standardSources) {
      expect(source.field in values.standard).toBe(true)
    }
  })

  it("reads billing address, first non-empty channel and the primary contact person", () => {
    const { standard } = lexwareContactSourceValues(contact)
    expect(standard).toMatchObject({
      street: "Münchnerstraße 24",
      zipCity: "80000 München",
      email: "info@x.de",
      "email.office": "office@x.de",
      phone: "0170 1",
      "contactPerson.name": "Max Haupt",
      "contactPerson.phone": "089 1",
      note: "Bauleistung §13b",
      customerNumber: "10010",
      vatRegistrationId: "DE123456789",
    })
  })

  it("falls back to the shipping address", () => {
    const { standard } = lexwareContactSourceValues({
      ...contact,
      addresses: { shipping: [{ city: "Augsburg" }] },
    })
    expect(standard.street).toBeUndefined()
    expect(standard.zipCity).toBe("Augsburg")
  })
})

describe("buildDimaconCustomerBody", () => {
  it("reproduces the fixed mapping with the default rules", () => {
    expect(build(catalog.defaultRules).body).toEqual({
      name: "Neu Bau GmbH",
      customerNumber: "10010",
      street: "Münchnerstraße 24",
      zipCity: "80000 München",
      email: "info@x.de",
      phoneNumber: "0170 1",
      customAttributeValues: [],
    })
  })

  it("maps into description and dimacon attributes", () => {
    const discovery: Discovery = {
      ...EMPTY_DISCOVERY,
      targetAttributes: [{ id: "attr-ust", label: "USt-IdNr.", type: "STRING", isActive: true }],
    }
    const { body } = build(
      [
        {
          source: { kind: "standard", field: "note" },
          target: { kind: "standard", field: "description" },
        },
        {
          source: { kind: "standard", field: "vatRegistrationId" },
          target: { kind: "attribute", attributeId: "attr-ust" },
        },
      ],
      discovery,
    )
    expect(body).toEqual({
      name: "Neu Bau GmbH",
      customerNumber: "10010",
      description: "Bauleistung §13b",
      customAttributeValues: [{ attributeId: "attr-ust", value: "DE123456789" }],
    })
  })
})
