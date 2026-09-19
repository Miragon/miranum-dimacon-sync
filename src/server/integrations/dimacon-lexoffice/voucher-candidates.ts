import type { Client as LexofficeClient } from "@miragon/client-lexoffice"
import { NO_RATE_LIMIT_RETRY, withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"

/**
 * Zeitfenster der Übernahme Lexware → Dimacon: nur Kontakte mit einem Beleg
 * (Angebot/Auftragsbestätigung), dessen Belegdatum höchstens so viele Tage
 * zurückliegt. Der Lexware-Bestand enthält über Jahre angesammelte Alt- und
 * Einmalkunden — die sollen beim Einschalten NICHT in der Planung landen.
 */
export const IMPORT_WINDOW_DAYS = 14

/** Belegarten, die einen Kontakt zum Übernahme-Kandidaten machen. */
const CANDIDATE_VOUCHER_TYPES = "quotation,orderconfirmation"

/** Abgelehnte/stornierte Belege begründen keinen Planungskunden. */
const IGNORED_VOUCHER_STATUSES = new Set(["rejected", "voided"])

const PAGE_SIZE = 250

/**
 * Fail-Safe-Deckel: 20 Seiten à 250 = 5.000 Belege in 14 Tagen. Darüber gilt
 * die Liste als unzuverlässig und die Übernahme fällt für den Lauf aus.
 */
export const MAX_VOUCHER_PAGES = 20

interface LexVoucherListItem {
  id: string
  voucherType?: string
  voucherStatus?: string
  voucherNumber?: string
  contactId?: string | null
  contactName?: string
}

interface LexVoucherListPage {
  content?: LexVoucherListItem[]
  totalPages?: number
  last?: boolean
}

export interface ImportCandidate {
  contactId: string
  /** Name laut Beleg — nur Anzeige, falls der Kontakt selbst nicht auflösbar ist */
  contactName: string
  /** Belegnummern (bzw. Beleg-IDs für Entwürfe ohne Nummer) */
  vouchers: string[]
}

/**
 * Alle Kontakte mit Angebot oder Auftragsbestätigung ab `voucherDateFrom`
 * (YYYY-MM-DD, inklusiv), je Kontakt EIN Kandidat. Belege ohne `contactId`
 * (Sammelkunde / einmalige Adresse) haben keinen Kontakt, den man übernehmen
 * könnte, und fallen still heraus.
 *
 * Fail-closed wie der Kontakt-Index: bricht die Paginierung ab (Deckel,
 * Antwort ohne Seitenangabe, Fehler ab Seite 2), wird `undefined` geliefert.
 * Eine halbe Liste würde zwar nie falsch ANLEGEN, aber der Lauf meldete
 * „nichts zu übernehmen", obwohl die Liste gar nicht vollständig gelesen
 * wurde. Seite 0 wirft weiter — der Aufrufer entscheidet.
 */
export async function loadVoucherCandidates(
  client: LexofficeClient,
  voucherDateFrom: string,
  log?: Logger,
  maxPages = MAX_VOUCHER_PAGES,
): Promise<ImportCandidate[] | undefined> {
  const fetchPage = (page: number) =>
    withRetry(
      () =>
        client.get<LexVoucherListPage>("/v1/voucherlist", {
          voucherType: CANDIDATE_VOUCHER_TYPES,
          voucherStatus: "any",
          voucherDateFrom,
          page: String(page),
          size: String(PAGE_SIZE),
        }),
      // Der Lexware-Client retryt 429 bereits selbst (contact-lookup.ts).
      NO_RATE_LIMIT_RETRY,
    ) as Promise<LexVoucherListPage>

  const first = await fetchPage(0)
  if (first.totalPages === undefined && first.last !== true) {
    log?.warn("lexware voucher list discarded — Antwort ohne totalPages/last")
    return undefined
  }
  const totalPages = first.totalPages ?? 1
  if (totalPages > maxPages) {
    log?.warn("lexware voucher list discarded — page cap reached", { maxPages, totalPages })
    return undefined
  }

  const byContact = new Map<string, ImportCandidate>()
  let page = first
  for (let index = 0; ; index++) {
    for (const voucher of page.content ?? []) {
      if (!voucher.contactId) continue
      if (IGNORED_VOUCHER_STATUSES.has(voucher.voucherStatus ?? "")) continue
      const candidate = byContact.get(voucher.contactId) ?? {
        contactId: voucher.contactId,
        contactName: voucher.contactName?.trim() ?? "",
        vouchers: [],
      }
      candidate.vouchers.push(voucher.voucherNumber?.trim() || voucher.id)
      byContact.set(voucher.contactId, candidate)
    }

    const next = index + 1
    if (page.last === true || next >= totalPages) break

    try {
      page = await fetchPage(next)
    } catch (err) {
      log?.warn("lexware voucher list discarded — page load failed", {
        page: next,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  return [...byContact.values()]
}
