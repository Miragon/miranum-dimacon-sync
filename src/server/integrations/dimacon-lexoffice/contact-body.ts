import type { AppliedMapping } from "../shared/field-mapping.js"

/**
 * Faltet die flachen, gepunkteten Mapping-Ziele (company.name,
 * addresses.billing.street, emailAddresses.business, note …) in den
 * verschachtelten Lexware-Kontakt-Create-Body. Blöcke ohne einen einzigen
 * Wert werden weggelassen (wie im bisherigen hartkodierten Body);
 * Basis-Felder (version, roles.customer, countryCode) sind fixiert.
 */
export interface LexContactCreateBody {
  version: 0
  roles: { customer: Record<string, never> }
  company: { name: string }
  addresses?: {
    billing: [
      {
        supplement?: string
        street?: string
        zip?: string
        city?: string
        countryCode: "DE"
      },
    ]
  }
  emailAddresses?: { business: [string] }
  phoneNumbers?: { business: [string] }
  note?: string
}

export function buildLexofficeContactBody(
  applied: AppliedMapping,
  /** Match-Key: kommt immer aus dem Dimacon-Kundennamen, nie aus dem Mapping */
  companyName: string,
): LexContactCreateBody {
  const f = applied.standardFields
  const value = (key: string): string | undefined => {
    const v = f[key]
    return v == null || v.trim() === "" ? undefined : v
  }

  const body: LexContactCreateBody = {
    version: 0,
    roles: { customer: {} },
    company: { name: companyName },
  }

  const billing = {
    supplement: value("addresses.billing.supplement"),
    street: value("addresses.billing.street"),
    zip: value("addresses.billing.zip"),
    city: value("addresses.billing.city"),
  }
  if (Object.values(billing).some((v) => v !== undefined)) {
    body.addresses = { billing: [{ ...billing, countryCode: "DE" }] }
  }

  const email = value("emailAddresses.business")
  if (email) body.emailAddresses = { business: [email] }

  const phone = value("phoneNumbers.business")
  if (phone) body.phoneNumbers = { business: [phone] }

  const note = value("note")
  if (note) body.note = note

  return body
}
