import type { AppliedMapping, SourceValues } from "../shared/field-mapping.js"
import { contactNumber } from "./contact-lookup.js"
import type { LexAddress, LexContact } from "./contact-lookup.js"

/**
 * Gegenstück zu contact-body.ts für die Übernahme Lexware → Dimacon: liefert
 * die Quellwerte eines Lexware-Kontakts (Schlüssel = `standardSources` von
 * FIELD_CATALOG.dimaconCustomer) und baut aus der angewandten Zuordnung den
 * Create-Body des Dimacon-Kunden.
 */

export interface DimaconCustomerCreateBody {
  name: string
  customerNumber: string
  street?: string
  zipCity?: string
  phoneNumber?: string
  email?: string
  description?: string
  customAttributeValues: { attributeId: string; value: string }[]
}

const EMAIL_ORDER = ["business", "office", "private", "other"] as const
const PHONE_ORDER = ["business", "office", "mobile", "private", "other"] as const

export function lexwareContactSourceValues(contact: LexContact): SourceValues {
  const address: LexAddress | undefined =
    contact.addresses?.billing?.[0] ?? contact.addresses?.shipping?.[0]
  const zip = clean(address?.zip)
  const city = clean(address?.city)
  const persons = contact.company?.contactPersons ?? []
  const person = persons.find((p) => p.primary) ?? persons[0]
  const email = (key: (typeof EMAIL_ORDER)[number]) => firstOf(contact.emailAddresses?.[key])
  const phone = (key: (typeof PHONE_ORDER)[number]) => firstOf(contact.phoneNumbers?.[key])

  return {
    standard: {
      street: clean(address?.street),
      zip,
      city,
      zipCity: [zip, city].filter(Boolean).join(" ") || undefined,
      supplement: clean(address?.supplement),
      email: EMAIL_ORDER.map(email).find(Boolean),
      "email.business": email("business"),
      "email.office": email("office"),
      "email.private": email("private"),
      "email.other": email("other"),
      phone: PHONE_ORDER.map(phone).find(Boolean),
      "phone.business": phone("business"),
      "phone.office": phone("office"),
      "phone.mobile": phone("mobile"),
      "phone.private": phone("private"),
      "contactPerson.name":
        [person?.firstName, person?.lastName].map(clean).filter(Boolean).join(" ") || undefined,
      "contactPerson.email": clean(person?.emailAddress),
      "contactPerson.phone": clean(person?.phoneNumber),
      note: clean(contact.note),
      customerNumber: contactNumber(contact),
      vatRegistrationId: clean(contact.company?.vatRegistrationId),
      taxNumber: clean(contact.company?.taxNumber),
    },
    attributes: new Map(),
  }
}

/** Name + Nummer sind Match-Keys und kommen nie aus der Zuordnung. */
export function buildDimaconCustomerBody(
  applied: AppliedMapping,
  name: string,
  customerNumber: string,
): DimaconCustomerCreateBody {
  const body: DimaconCustomerCreateBody = {
    name,
    customerNumber,
    customAttributeValues: applied.attributeValues,
  }
  for (const field of ["street", "zipCity", "phoneNumber", "email", "description"] as const) {
    const value = clean(applied.standardFields[field] ?? undefined)
    if (value) body[field] = value
  }
  return body
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function firstOf(values: string[] | undefined): string | undefined {
  return values?.map((v) => v.trim()).find(Boolean)
}
