import type { Client as LexofficeClient } from "@miragon/client-lexoffice"
import { NO_RATE_LIMIT_RETRY, withRetry } from "../../lib/concurrency.js"
import { normalizeName } from "../shared/matching.js"

export interface LexContact {
  id: string
  version: number
  /** `vendor` wird nur modelliert, um reine Lieferanten erkennen zu können. */
  roles?: { customer?: { number?: string | number }; vendor?: { number?: string | number } }
  company?: { name?: string }
  person?: { firstName?: string; lastName?: string }
  archived?: boolean
}

export interface LexContactsResponse {
  content?: LexContact[]
}

/** Anzeigename eines Kontakts: Firma, sonst Personenname. */
export function contactName(contact: LexContact): string {
  const company = contact.company?.name?.trim()
  if (company) return company
  return [contact.person?.firstName, contact.person?.lastName]
    .filter((p) => p && p.trim())
    .join(" ")
    .trim()
}

/** Kundennummer eines Kontakts als getrimmter String (JSON liefert sie mal als Zahl). */
export function contactNumber(contact: LexContact): string | undefined {
  const raw = contact.roles?.customer?.number
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  return value === "" ? undefined : value
}

/**
 * Der `number`-Filter von `GET /v1/contacts` ist ein Integer — Dimacon-
 * Nummern wie "K-1001" taugen dafür nicht und gehen direkt auf den
 * Namensweg. Sehr lange Werte werden ebenfalls verworfen (Integer-Bereich).
 */
export function numericLexwareNumber(raw: string | null | undefined): string | undefined {
  const value = (raw ?? "").trim()
  return /^\d{1,9}$/.test(value) ? value : undefined
}

/**
 * Ein Kontakt zählt für den Abgleich nur, wenn er wirklich Kunde ist:
 * Kundenrolle vorhanden und nicht archiviert. Ein reiner Lieferanten-Kontakt
 * gleichen Firmennamens würde sonst als Treffer gelten und die Anlage des
 * Kunden-Kontakts still blockieren; ein archivierter Kontakt ist in Lexware
 * ausgemustert und darf keinen aktiven Kunden vertreten.
 */
export function isActiveCustomerContact(contact: LexContact): boolean {
  return contact.roles?.customer !== undefined && contact.archived !== true
}

/**
 * Kapselt die Kontakt-Suche gegen die Lexware-API. Beide Lookups liefern
 * bewusst ALLE Kandidaten (kein `.find()`): Mehrdeutigkeit muss oben
 * entscheidbar bleiben. #15 kann diese Schicht später gegen einen vorab
 * geladenen Voll-Index tauschen, ohne die Auflösungslogik anzufassen.
 */
export class LexofficeContactLookup {
  constructor(private readonly client: LexofficeClient) {}

  /** Alle aktiven Kunden-Kontakte mit exakt dieser Kundennummer. */
  async byNumber(number: string): Promise<LexContact[]> {
    const response = (await withRetry(
      () => this.client.get<LexContactsResponse>("/v1/contacts", { number, size: "250" }),
      // Der Lexware-Client retryt 429 bereits selbst (bis zu 4 HTTP-Calls je
      // Aufruf) — ohne NO_RATE_LIMIT_RETRY multipliziert sich das auf ~20.
      NO_RATE_LIMIT_RETRY,
    )) as LexContactsResponse
    // Dem Filter wird nie vertraut: lokal gegen die Kundennummer verifizieren
    // (der Filter könnte auf die Lieferantennummer oder unscharf matchen).
    const wanted = number.trim()
    return (response.content ?? []).filter(
      (c) => isActiveCustomerContact(c) && contactNumber(c) === wanted,
    )
  }

  /**
   * Alle aktiven Kunden-Kontakte mit exakt (normalisiert) diesem Namen.
   *
   * Verglichen wird gegen `contactName()` — dieselbe Namensdefinition wie in
   * Stufe 1 der Auflösung. Nur gegen `company.name` zu vergleichen machte
   * einen in Lexware als Privatperson angelegten Kontakt unsichtbar und legte
   * bei jedem Lauf ein firmenförmiges Duplikat daneben.
   */
  async byName(name: string): Promise<LexContact[]> {
    // size=250 (Lexware-Maximum): der Name-Filter matcht Substrings — bei
    // der Default-Seitengröße 25 könnte der exakte Treffer auf Seite 2 liegen
    // und das Find-or-Create würde Duplikate anlegen. `customer=true` hält
    // reine Lieferanten schon serverseitig aus dieser Seite heraus.
    const response = (await withRetry(
      () =>
        this.client.get<LexContactsResponse>("/v1/contacts", {
          name,
          customer: "true",
          size: "250",
        }),
      // s. byNumber: der 429-Retry gehört dem Lexware-Client allein.
      NO_RATE_LIMIT_RETRY,
    )) as LexContactsResponse
    const wanted = normalizeName(name)
    // Dem Filter wird nie vertraut (analog byNumber): Rolle und Archiv-Status
    // werden lokal nachgeprüft.
    return (response.content ?? []).filter(
      (c) => isActiveCustomerContact(c) && normalizeName(contactName(c)) === wanted,
    )
  }
}
