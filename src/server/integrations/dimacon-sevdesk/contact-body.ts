import type { AppliedMapping } from "../shared/field-mapping.js"

/**
 * Faltet die flachen, gepunkteten Mapping-Ziele (address.street,
 * communication.email, description …) in die sevDesk-Bodies. Anders als
 * der eine verschachtelte Lexware-Body sind es hier DREI Ressourcen:
 * Contact + optional ContactAddress + CommunicationWays (je eigener POST,
 * der Aligner hängt die Contact-Referenz nach dem Create an). Blöcke ohne
 * einen einzigen Wert werden weggelassen.
 *
 * Die IDs sind sevDesk-Systemkonstanten der Standard-Installation
 * (Kategorie 3 = Kunde, StaticCountry 1 = Deutschland,
 * CommunicationWayKey 2 = geschäftlich) — beim ersten Live-Test gegen den
 * echten Account verifizieren.
 */
export const CUSTOMER_CATEGORY = { id: 3, objectName: "Category" } as const
export const COUNTRY_GERMANY = { id: 1, objectName: "StaticCountry" } as const
export const COMM_WAY_KEY_WORK = { id: 2, objectName: "CommunicationWayKey" } as const

export interface SevdeskContactCreateBody {
  name: string
  category: typeof CUSTOMER_CATEGORY
  customerNumber?: string
  description?: string
}

export interface SevdeskAddressCreateBody {
  street?: string
  zip?: string
  city?: string
  country: typeof COUNTRY_GERMANY
}

export interface SevdeskCommunicationWayCreateBody {
  type: "EMAIL" | "PHONE"
  value: string
  key: typeof COMM_WAY_KEY_WORK
  main: boolean
}

export interface SevdeskContactCreatePayload {
  contact: SevdeskContactCreateBody
  address?: SevdeskAddressCreateBody
  communicationWays: SevdeskCommunicationWayCreateBody[]
}

export function buildSevdeskContactBodies(
  applied: AppliedMapping,
  /** Match-Key: kommt immer aus dem Dimacon-Kundennamen, nie aus dem Mapping */
  name: string,
  /** Nur gesetzt, wenn die Dimacon-Nummer in sevDesk nachweislich frei ist */
  customerNumber?: string,
): SevdeskContactCreatePayload {
  const f = applied.standardFields
  const value = (key: string): string | undefined => {
    const v = f[key]
    return v == null || v.trim() === "" ? undefined : v
  }

  const contact: SevdeskContactCreateBody = {
    name,
    category: CUSTOMER_CATEGORY,
  }
  if (customerNumber) contact.customerNumber = customerNumber
  const description = value("description")
  if (description) contact.description = description

  const address = {
    street: value("address.street"),
    zip: value("address.zip"),
    city: value("address.city"),
  }
  const hasAddress = Object.values(address).some((v) => v !== undefined)

  const communicationWays: SevdeskCommunicationWayCreateBody[] = []
  const email = value("communication.email")
  if (email)
    communicationWays.push({ type: "EMAIL", value: email, key: COMM_WAY_KEY_WORK, main: true })
  const phone = value("communication.phone")
  if (phone)
    communicationWays.push({ type: "PHONE", value: phone, key: COMM_WAY_KEY_WORK, main: true })

  return {
    contact,
    ...(hasAddress ? { address: { ...address, country: COUNTRY_GERMANY } } : {}),
    communicationWays,
  }
}
