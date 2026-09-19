import type { Client as LexofficeClient } from "@miragon/client-lexoffice"
import { NO_RATE_LIMIT_RETRY, withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import { normalizeName } from "../shared/matching.js"
import { contactName, contactNumber, isActiveCustomerContact } from "./contact-lookup.js"
import type { ContactSource, LexContact } from "./contact-lookup.js"

/** Lexware-Maximum je Seite. */
const PAGE_SIZE = 250

/**
 * Fail-Safe-Deckel gegen endlose Paginierung. 200 Seiten à 250 Kontakte =
 * 50.000 Kontakte; darüber wird der Index verworfen statt halb aufgebaut.
 */
export const MAX_CONTACT_PAGES = 200

interface LexContactPage {
  content?: LexContact[]
  totalPages?: number
  last?: boolean
  number?: number
}

/**
 * Lokaler Voll-Index der Lexware-Kontakte.
 *
 * MEHRWERTIG (Map<Schlüssel, Kontakt[]>) und damit signaturgleich zu
 * `LexofficeContactLookup`: die Auflösung im Aligner meldet mehrere Treffer
 * als `ambiguous` und schreibt dann NICHT. Ein einwertiger Index würde genau
 * diesen Schutz still aushebeln.
 */
export class LexwareContactIndex implements ContactSource {
  private readonly byNumberKey = new Map<string, LexContact[]>()
  private readonly byNameKey = new Map<string, LexContact[]>()
  /**
   * ALLE Kontakte nach ID, auch archivierte und reine Lieferanten: die
   * Übernahme nach Dimacon löst Beleg-Kontakte darüber auf und muss
   * begründen können, WARUM einer nicht übernommen wird.
   */
  private readonly byIdKey = new Map<string, LexContact>()
  private count = 0

  constructor(contacts: readonly LexContact[] = []) {
    for (const contact of contacts) this.add(contact)
  }

  /** Nummer/Name nur für aktive Kunden-Kontakte — identischer Filter wie die Serversuche. */
  add(contact: LexContact): void {
    this.byIdKey.set(contact.id, contact)
    if (!isActiveCustomerContact(contact)) return
    this.count++
    push(this.byNumberKey, contactNumber(contact) ?? "", contact)
    push(this.byNameKey, normalizeName(contactName(contact)), contact)
  }

  async byNumber(number: string): Promise<LexContact[]> {
    return this.byNumberKey.get(number.trim()) ?? []
  }

  async byName(name: string): Promise<LexContact[]> {
    return this.byNameKey.get(normalizeName(name)) ?? []
  }

  /** Beliebiger Kontakt nach ID — ungefiltert, s. `byIdKey`. */
  byId(id: string): LexContact | undefined {
    return this.byIdKey.get(id)
  }

  get size(): number {
    return this.count
  }
}

function push(map: Map<string, LexContact[]>, key: string, contact: LexContact): void {
  if (!key) return
  const list = map.get(key) ?? []
  list.push(contact)
  map.set(key, list)
}

/**
 * Lädt ALLE Lexware-Kontakte paginiert und baut daraus den lokalen Index.
 * Aus O(Kunden) Einzelsuchen werden O(Seiten) Requests.
 *
 * Fail-closed: bricht die Paginierung ab (Deckel, unerwartete Antwort,
 * Fehler ab Seite 2), wird `undefined` geliefert und der Aligner bleibt bei
 * der Serversuche — ein halber Index ließe eine Mehrdeutigkeit als
 * „eindeutig" durchgehen und legte Duplikate an.
 *
 * Alle Aufrufe laufen mit `NO_RATE_LIMIT_RETRY`: der Lexware-Client retryt
 * 429 bereits selbst mit Retry-After.
 */
export async function loadLexwareContactIndex(
  client: LexofficeClient,
  log?: Logger,
  maxPages = MAX_CONTACT_PAGES,
): Promise<LexwareContactIndex | undefined> {
  const index = new LexwareContactIndex()
  let duplicateNames = 0
  const seenNames = new Set<string>()

  const fetchPage = (page: number) =>
    withRetry(
      () =>
        client.get<LexContactPage>("/v1/contacts", {
          page: String(page),
          size: String(PAGE_SIZE),
        }),
      NO_RATE_LIMIT_RETRY,
    ) as Promise<LexContactPage>

  // Seite 0 wirft weiter (harter Ladefehler) — der Aufrufer entscheidet.
  const first = await fetchPage(0)
  // Fail-closed: ohne verlässliche Seitenzahl wäre ein nach Seite 0
  // abgeschnittener Index „vollständig" — und der Aligner ersetzt die
  // Serversuche komplett durch ihn. Ein Kontakt auf einer nicht geladenen
  // Seite gälte dann als nicht vorhanden und würde erneut angelegt.
  if (first.totalPages === undefined && first.last !== true) {
    log?.warn("lexware contact index discarded — Antwort ohne totalPages/last")
    return undefined
  }
  const totalPages = first.totalPages ?? 1
  // Der Deckel steht nach Seite 0 fest — erst in der Schleife zu prüfen hieße,
  // maxPages Requests gegen eine auf 2 req/s limitierte API zu bezahlen und
  // den Index danach wegzuwerfen.
  if (totalPages > maxPages) {
    log?.warn("lexware contact index discarded — page cap reached", { maxPages, totalPages })
    return undefined
  }
  let page = first

  for (let index0 = 0; ; index0++) {
    for (const contact of page.content ?? []) {
      if (isActiveCustomerContact(contact)) {
        const key = normalizeName(contactName(contact))
        if (key && seenNames.has(key)) duplicateNames++
        else if (key) seenNames.add(key)
      }
      index.add(contact)
    }

    const next = index0 + 1
    if (page.last === true || next >= totalPages) break
    if (next >= maxPages) {
      log?.warn("lexware contact index discarded — page cap reached", { maxPages, totalPages })
      return undefined
    }

    try {
      page = await fetchPage(next)
    } catch (err) {
      log?.warn("lexware contact index discarded — page load failed", {
        page: next,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  if (duplicateNames > 0) {
    // Kein Fehler: die mehrwertigen Schlüssel machen daraus im Aligner eine
    // gemeldete Mehrdeutigkeit statt eines blinden Schreibvorgangs.
    log?.warn("lexware contacts share company names", { duplicateNames })
  }
  log?.info("lexware contact index built", { contacts: index.size, totalPages })
  return index
}
