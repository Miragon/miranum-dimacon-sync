import { describe, expect, it } from "vitest"
import { customerSourceValues, FIELD_CATALOG } from "../shared/field-catalog.js"
import { applyMapping, EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import {
  buildSevdeskContactBodies,
  COMM_WAY_KEY_WORK,
  COUNTRY_GERMANY,
  CUSTOMER_CATEGORY,
} from "./contact-body.js"

function applyDefaults(customer: Parameters<typeof customerSourceValues>[0]) {
  return applyMapping(
    FIELD_CATALOG.sevdeskContact.defaultRules,
    FIELD_CATALOG.sevdeskContact,
    EMPTY_DISCOVERY,
    customerSourceValues(customer),
  )
}

describe("buildSevdeskContactBodies", () => {
  it("default rules produce contact + address + communication ways", () => {
    const payload = buildSevdeskContactBodies(
      applyDefaults({
        name: "Muster GmbH",
        street: "Musterweg 1",
        zipCity: "80331 München",
        phoneNumber: "089 123",
        email: "info@muster.de",
      }),
      "Muster GmbH",
    )
    expect(payload).toEqual({
      contact: { name: "Muster GmbH", category: CUSTOMER_CATEGORY },
      address: {
        street: "Musterweg 1",
        zip: "80331",
        city: "München",
        country: COUNTRY_GERMANY,
      },
      communicationWays: [
        { type: "EMAIL", value: "info@muster.de", key: COMM_WAY_KEY_WORK, main: true },
        { type: "PHONE", value: "089 123", key: COMM_WAY_KEY_WORK, main: true },
      ],
    })
  })

  it("omits empty blocks entirely", () => {
    const payload = buildSevdeskContactBodies(
      applyDefaults({ name: "Nur Name GmbH" }),
      "Nur Name GmbH",
    )
    expect(payload).toEqual({
      contact: { name: "Nur Name GmbH", category: CUSTOMER_CATEGORY },
      communicationWays: [],
    })
    expect(payload.address).toBeUndefined()
  })

  it("passes a proven-free customer number through to the contact body", () => {
    const payload = buildSevdeskContactBodies(applyDefaults({ name: "N" }), "N", "D-100")
    expect(payload.contact.customerNumber).toBe("D-100")
  })

  it("name always comes from the match-key parameter, never from the mapping", () => {
    const applied = applyDefaults({ name: "Egal", description: "sollte nie Name werden" })
    applied.standardFields["name"] = "sollte nie Name werden"
    const payload = buildSevdeskContactBodies(applied, "Echter Name GmbH")
    expect(payload.contact.name).toBe("Echter Name GmbH")
  })

  it("maps description onto the contact via a custom rule", () => {
    const applied = applyMapping(
      [
        ...FIELD_CATALOG.sevdeskContact.defaultRules,
        {
          source: { kind: "standard", field: "description" },
          target: { kind: "standard", field: "description" },
        },
      ],
      FIELD_CATALOG.sevdeskContact,
      EMPTY_DISCOVERY,
      customerSourceValues({ name: "N", description: "wichtiger Kunde" }),
    )
    const payload = buildSevdeskContactBodies(applied, "N")
    expect(payload.contact.description).toBe("wichtiger Kunde")
  })
})
