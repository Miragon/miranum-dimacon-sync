import type { Client as SevdeskClient } from "@miragon/client-sevdesk"
import { NO_RATE_LIMIT_RETRY, withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import { normalizeName } from "../shared/matching.js"
import { contactName, contactNumber, isCustomerContact } from "./contact-lookup.js"
import type { ContactSource, SevdeskContact, SevdeskContactsResponse } from "./contact-lookup.js"

/** sevDesk-Maximum je Seite. */
const PAGE_SIZE = 1000

/**
 * Fail-Safe-Deckel gegen endlose Paginierung. 100 Seiten à 1000 Kontakte =
 * 100.000 Kontakte; darüber wird der Index verworfen statt halb aufgebaut.
 */
export const MAX_CONTACT_PAGES = 100

/**
 * Lokaler Voll-Index der sevDesk-Kontakte.
 *
 * MEHRWERTIG (Map<Schlüssel, Kontakt[]>) und damit signaturgleich zur
 * Serversuche: die Auflösung im Aligner meldet mehrere Treffer als
 * `ambiguous` und schreibt dann NICHT. Ein einwertiger Index würde genau
 * diesen Schutz still aushebeln. (Muster: dimacon-lexoffice/contact-index.ts.)
 */
export class SevdeskContactIndex implements ContactSource {
  private readonly byNumberKey = new Map<string, SevdeskContact[]>()
  private readonly byNameKey = new Map<string, SevdeskContact[]>()
  private count = 0

  constructor(contacts: readonly SevdeskContact[] = []) {
    for (const contact of contacts) this.add(contact)
  }

  /** Nur Kunden-Kontakte — identischer Filter wie die Serversuche. */
  add(contact: SevdeskContact): void {
    if (!isCustomerContact(contact)) return
    this.count++
    push(this.byNumberKey, contactNumber(contact) ?? "", contact)
    push(this.byNameKey, normalizeName(contactName(contact)), contact)
  }

  async byNumber(number: string): Promise<SevdeskContact[]> {
    return this.byNumberKey.get(number.trim()) ?? []
  }

  async byName(name: string): Promise<SevdeskContact[]> {
    return this.byNameKey.get(normalizeName(name)) ?? []
  }

  get size(): number {
    return this.count
  }
}

function push(map: Map<string, SevdeskContact[]>, key: string, contact: SevdeskContact): void {
  if (!key) return
  const list = map.get(key) ?? []
  list.push(contact)
  map.set(key, list)
}

/**
 * Lädt ALLE sevDesk-Kontakte paginiert (limit/offset, `depth=1` = auch
 * Personen) und baut daraus den lokalen Index. Aus O(Kunden) Einzelsuchen
 * werden O(Seiten) Requests.
 *
 * Fail-closed: eine Antwort ohne `objects`-Array, ein Fehler ab Seite 2 oder
 * der Seiten-Deckel verwerfen den Index (`undefined`) und der Aligner bleibt
 * bei der Serversuche — ein halber Index ließe eine Mehrdeutigkeit als
 * „eindeutig" durchgehen und legte Duplikate an. Seite 1 wirft weiter
 * (harter Ladefehler) — der Aufrufer entscheidet.
 */
export async function loadSevdeskContactIndex(
  client: SevdeskClient,
  log?: Logger,
  maxPages = MAX_CONTACT_PAGES,
): Promise<SevdeskContactIndex | undefined> {
  const index = new SevdeskContactIndex()
  let duplicateNames = 0
  const seenNames = new Set<string>()

  const fetchPage = (offset: number) =>
    withRetry(
      () =>
        client.get<SevdeskContactsResponse>("/Contact", {
          depth: "1",
          limit: String(PAGE_SIZE),
          offset: String(offset),
        }),
      // Der sevDesk-Client retryt 429 bereits selbst mit Retry-After.
      NO_RATE_LIMIT_RETRY,
    ) as Promise<SevdeskContactsResponse>

  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      log?.warn("sevdesk contact index discarded — page cap reached", { maxPages })
      return undefined
    }

    let response: SevdeskContactsResponse
    if (page === 0) {
      response = await fetchPage(0)
    } else {
      try {
        response = await fetchPage(page * PAGE_SIZE)
      } catch (err) {
        log?.warn("sevdesk contact index discarded — page load failed", {
          page,
          error: err instanceof Error ? err.message : String(err),
        })
        return undefined
      }
    }

    // Fail-closed: ohne `objects`-Array wäre ein leerer Index „vollständig" —
    // und der Aligner ersetzt die Serversuche komplett durch ihn. Jeder
    // Kontakt gälte dann als nicht vorhanden und würde erneut angelegt.
    if (!Array.isArray(response.objects)) {
      log?.warn("sevdesk contact index discarded — Antwort ohne objects-Array")
      return undefined
    }

    for (const contact of response.objects) {
      if (isCustomerContact(contact)) {
        const key = normalizeName(contactName(contact))
        if (key && seenNames.has(key)) duplicateNames++
        else if (key) seenNames.add(key)
      }
      index.add(contact)
    }

    if (response.objects.length < PAGE_SIZE) break
  }

  if (duplicateNames > 0) {
    // Kein Fehler: die mehrwertigen Schlüssel machen daraus im Aligner eine
    // gemeldete Mehrdeutigkeit statt eines blinden Schreibvorgangs.
    log?.warn("sevdesk contacts share names", { duplicateNames })
  }
  log?.info("sevdesk contact index built", { contacts: index.size })
  return index
}
