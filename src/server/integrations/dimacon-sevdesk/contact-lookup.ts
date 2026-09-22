import type { Client as SevdeskClient } from "@miragon/client-sevdesk"
import { NO_RATE_LIMIT_RETRY, withRetry } from "../../lib/concurrency.js"
import { normalizeName } from "../shared/matching.js"

/**
 * sevDesk-Systemkategorie "Lieferant" (id 2). Kontakte JEDER anderen
 * Kategorie zählen für den Abgleich als Kunde: sevDesk-Kategorien sind
 * frei erweiterbar (anders als die strukturellen Lexware-Rollen) — ein
 * Mandant mit eigener Kunden-Kategorie bekäme sonst bei jedem Lauf ein
 * Duplikat neben den bestehenden Kontakt gelegt.
 */
const SUPPLIER_CATEGORY_ID = "2"

export interface SevdeskContact {
  id: string
  /** Organisationsname; bei Personen leer */
  name?: string | null
  /** Personen: Vorname (sevDesk-Schreibweise "surename") */
  surename?: string | null
  familyname?: string | null
  customerNumber?: string | number | null
  category?: { id?: string | number; objectName?: string } | null
}

/** Listen-Envelope von GET /Contact. */
export interface SevdeskContactsResponse {
  objects?: SevdeskContact[]
}

/** Anzeigename eines Kontakts: Organisation, sonst Personenname. */
export function contactName(contact: SevdeskContact): string {
  const org = contact.name?.trim()
  if (org) return org
  return [contact.surename, contact.familyname]
    .filter((p) => p && p.trim())
    .join(" ")
    .trim()
}

/** Kundennummer eines Kontakts als getrimmter String (JSON liefert sie mal als Zahl). */
export function contactNumber(contact: SevdeskContact): string | undefined {
  const raw = contact.customerNumber
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  return value === "" ? undefined : value
}

/**
 * Der `customerNumber`-Filter von GET /Contact nimmt beliebige Strings —
 * anders als Lexware gibt es keine Integer-Einschränkung, nur leer ist
 * kein Schlüssel.
 */
export function sevdeskNumberKey(raw: string | null | undefined): string | undefined {
  const value = (raw ?? "").trim()
  return value === "" ? undefined : value
}

/** Kontakt zählt für den Abgleich, solange er nicht explizit Lieferant ist. */
export function isCustomerContact(contact: SevdeskContact): boolean {
  const categoryId = contact.category?.id
  return categoryId === undefined || categoryId === null
    ? true
    : String(categoryId) !== SUPPLIER_CATEGORY_ID
}

/**
 * Quelle der Kontakt-Auflösung. Beide Implementierungen (Serversuche und
 * vorab geladener Voll-Index) liefern ALLE Kandidaten — nur so bleibt
 * Mehrdeutigkeit im Aligner entscheidbar. (Gleiches Muster wie
 * dimacon-lexoffice/contact-lookup.ts.)
 */
export interface ContactSource {
  byNumber(number: string): Promise<SevdeskContact[]>
  byName(name: string): Promise<SevdeskContact[]>
  /** Nur der lokale Index trägt im Lauf angelegte Kontakte nach. */
  add?(contact: SevdeskContact): void
}

/** sevDesk-Maximum je Seite. */
const PAGE_SIZE = "1000"

/**
 * Kapselt die Kontakt-Suche gegen die sevDesk-API (Fallback, wenn der
 * Voll-Index nicht geladen werden konnte). Beide Lookups liefern bewusst
 * ALLE Kandidaten (kein `.find()`), und den Server-Filtern wird nie
 * vertraut — Nummer und Name werden lokal exakt nachgeprüft (die Semantik
 * der sevDesk-Filter ist nicht dokumentiert). `depth=1` schließt Personen
 * ein — ein als Person angelegter Kunde wäre sonst unsichtbar und bekäme
 * bei jedem Lauf ein Organisations-Duplikat daneben.
 */
export class SevdeskContactLookup implements ContactSource {
  constructor(private readonly client: SevdeskClient) {}

  /** Alle Kunden-Kontakte mit exakt dieser Kundennummer. */
  async byNumber(number: string): Promise<SevdeskContact[]> {
    const response = (await withRetry(
      () =>
        this.client.get<SevdeskContactsResponse>("/Contact", {
          customerNumber: number,
          depth: "1",
          limit: PAGE_SIZE,
        }),
      // Der sevDesk-Client retryt 429 bereits selbst — s. NO_RATE_LIMIT_RETRY.
      NO_RATE_LIMIT_RETRY,
    )) as SevdeskContactsResponse
    const wanted = number.trim()
    return (response.objects ?? []).filter(
      (c) => isCustomerContact(c) && contactNumber(c) === wanted,
    )
  }

  /** Alle Kunden-Kontakte mit exakt (normalisiert) diesem Namen. */
  async byName(name: string): Promise<SevdeskContact[]> {
    // limit=1000 (sevDesk-Maximum): matcht der Name-Filter Substrings, dürfte
    // der exakte Treffer sonst hinter der Seitengrenze liegen und das
    // Find-or-Create legte ein Duplikat an.
    const response = (await withRetry(
      () =>
        this.client.get<SevdeskContactsResponse>("/Contact", {
          name,
          depth: "1",
          limit: PAGE_SIZE,
        }),
      NO_RATE_LIMIT_RETRY,
    )) as SevdeskContactsResponse
    const wanted = normalizeName(name)
    return (response.objects ?? []).filter(
      (c) => isCustomerContact(c) && normalizeName(contactName(c)) === wanted,
    )
  }
}
