import { describe, expect, it } from "vitest"
import { customerSourceValues, FIELD_CATALOG } from "../shared/field-catalog.js"
import { applyMapping, EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import { buildLexofficeContactBody } from "./contact-body.js"

function applyDefaults(customer: Parameters<typeof customerSourceValues>[0]) {
  return applyMapping(
    FIELD_CATALOG.lexofficeContact.defaultRules,
    FIELD_CATALOG.lexofficeContact,
    EMPTY_DISCOVERY,
    customerSourceValues(customer),
  )
}

describe("buildLexofficeContactBody", () => {
  it("default rules reproduce the legacy create body", () => {
    const body = buildLexofficeContactBody(
      applyDefaults({
        name: "Muster GmbH",
        street: "Musterweg 1",
        zipCity: "80331 München",
        phoneNumber: "089 123",
        email: "info@muster.de",
      }),
      "Muster GmbH",
    )
    expect(body).toEqual({
      version: 0,
      roles: { customer: {} },
      company: { name: "Muster GmbH" },
      addresses: {
        billing: [
          {
            supplement: undefined,
            street: "Musterweg 1",
            zip: "80331",
            city: "München",
            countryCode: "DE",
          },
        ],
      },
      emailAddresses: { business: ["info@muster.de"] },
      phoneNumbers: { business: ["089 123"] },
    })
  })

  it("omits empty blocks entirely", () => {
    const body = buildLexofficeContactBody(
      applyDefaults({ name: "Nur Name GmbH" }),
      "Nur Name GmbH",
    )
    expect(body).toEqual({
      version: 0,
      roles: { customer: {} },
      company: { name: "Nur Name GmbH" },
    })
  })

  it("company name always comes from the match-key parameter, never from the mapping", () => {
    // company.name ist fixiert — selbst wenn eine (hypothetische) Regel den
    // Wert setzen würde, gewinnt der Parameter.
    const applied = applyDefaults({ name: "Egal", description: "sollte nie Firma werden" })
    applied.standardFields["company.name"] = "sollte nie Firma werden"
    const body = buildLexofficeContactBody(applied, "Echter Name GmbH")
    expect(body.company.name).toBe("Echter Name GmbH")
  })

  it("maps description onto note via a custom rule", () => {
    const applied = applyMapping(
      [
        ...FIELD_CATALOG.lexofficeContact.defaultRules,
        {
          source: { kind: "standard", field: "description" },
          target: { kind: "standard", field: "note" },
        },
      ],
      FIELD_CATALOG.lexofficeContact,
      EMPTY_DISCOVERY,
      customerSourceValues({ name: "N", description: "wichtiger Kunde" }),
    )
    const body = buildLexofficeContactBody(applied, "N")
    expect(body.note).toBe("wichtiger Kunde")
  })

  it("keeps the address block when only zip/city are mapped (no street)", () => {
    const body = buildLexofficeContactBody(
      applyDefaults({ name: "N", zipCity: "80331 München" }),
      "N",
    )
    expect(body.addresses?.billing[0]).toMatchObject({
      zip: "80331",
      city: "München",
      countryCode: "DE",
    })
  })
})
