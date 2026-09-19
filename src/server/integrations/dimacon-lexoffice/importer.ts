import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { NON_IDEMPOTENT_RETRY, withRetry } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { applyMapping, attributeTargetProblem } from "../shared/field-mapping.js"
import type { DimaconAttributeDef } from "../shared/field-mapping.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { duplicateKeys } from "../shared/matching.js"
import { contactName, contactNumber } from "./contact-lookup.js"
import type { LexContact } from "./contact-lookup.js"
import { buildDimaconCustomerBody, lexwareContactSourceValues } from "./customer-body.js"
import { decideImport, indexDimaconCustomers } from "./import-policy.js"
import type { CustomerImportRow } from "./types.js"
import type { ImportCandidate } from "./voucher-candidates.js"

export interface ImportFromLexwareOptions {
  dimaconClient: DimaconClient
  log: Logger
  dryRun: boolean
  candidates: readonly ImportCandidate[]
  /** Kontakt-Auflösung aus dem VOLLSTÄNDIGEN Lexware-Index */
  contactById: (id: string) => LexContact | undefined
  /** Dimacon-Bestand, wie ihn der Vorwärts-Abgleich geladen hat */
  customers: readonly DimaconCustomerInfo[]
  /** Im Vorwärts-Abgleich zugeordnete Lexware-Kontakte (s. ImportPolicyInput) */
  claimed: ReadonlySet<string>
  /** Zuordnung `dimaconCustomer` — Discovery (Pflicht-Attribute) ist immer geladen */
  mapping: EntityMappingContext
  onMappingWarning: (message: string) => void
}

export interface ImportOutcome {
  rows: CustomerImportRow[]
  /** Gesetzt ⇒ die Übernahme hat in diesem Lauf nichts angelegt (Grund) */
  blocked?: string
}

/**
 * Übernahme Lexware → Dimacon: legt Beleg-Kontakte, die in Dimacon fehlen,
 * dort als Kunden an. Sequenziell — es geht um eine Handvoll Kunden je
 * Zeitfenster, nicht um den Gesamtbestand.
 */
export async function importFromLexware(opts: ImportFromLexwareOptions): Promise<ImportOutcome> {
  const { dimaconClient, log, dryRun, candidates, contactById, claimed, mapping } = opts
  const dimaconKeys = indexDimaconCustomers(opts.customers)
  // Zwei Beleg-Kontakte gleichen Namens würden zwei gleichnamige
  // Dimacon-Kunden erzeugen — welcher gemeint ist, entscheidet ein Mensch.
  const duplicateCandidateNames = duplicateKeys(candidates, (c) => {
    const contact = contactById(c.contactId)
    return contact ? contactName(contact) : undefined
  })
  const required = mapping.discovery.targetAttributes.filter((a) => a.isActive && a.isRequired)
  const blocked = unmappedRequiredMessage(required, mapping)
  const rows: CustomerImportRow[] = []

  for (const candidate of candidates) {
    const contact = contactById(candidate.contactId)
    const decision = decideImport(contact, {
      claimed,
      dimacon: dimaconKeys,
      duplicateCandidateNames,
    })
    if (decision.kind === "linked") continue

    const base = {
      lexwareContactId: candidate.contactId,
      lexwareNumber: contact ? contactNumber(contact) : undefined,
      name: (contact && contactName(contact)) || candidate.contactName || candidate.contactId,
      vouchers: candidate.vouchers,
    }

    if (decision.kind === "skip") {
      rows.push({ ...base, status: "skipped", reason: decision.reason })
      continue
    }
    // decideImport liefert ohne Kontakt immer `skip`
    if (!contact) continue
    if (blocked) {
      rows.push({
        ...base,
        status: "skipped",
        reason: "Pflicht-Attribut in Dimacon ohne Zuordnung — nicht angelegt (siehe Fehler)",
      })
      continue
    }

    const applied = applyMapping(
      mapping.rules,
      mapping.catalog,
      mapping.discovery,
      lexwareContactSourceValues(contact),
    )
    for (const warning of applied.warnings) {
      opts.onMappingWarning(`Kunde ${decision.name}: ${warning.message}`)
    }
    const filled = new Set(applied.attributeValues.map((v) => v.attributeId))
    const empty = required.filter((a) => !filled.has(a.id))
    if (empty.length > 0) {
      rows.push({
        ...base,
        status: "skipped",
        reason: `Pflicht-Attribut ${quoteLabels(empty)} bliebe leer — nicht angelegt`,
      })
      continue
    }
    const body = buildDimaconCustomerBody(applied, decision.name, decision.customerNumber)

    if (dryRun) {
      log.info("[dryRun] would create dimacon customer from lexware", {
        lexwareContactId: candidate.contactId,
        name: body.name,
      })
      rows.push({ ...base, status: "created", reason: "[dryRun] Dimacon-Kunde würde angelegt" })
      continue
    }

    try {
      const created = (await withRetry(
        () => dimacon.createNewCustomer({ client: dimaconClient, body }),
        // Nicht idempotent: ein verlorener Response nach erfolgreicher Anlage
        // heilt der nächste Lauf selbst (Nummer vorhanden ⇒ `linked`).
        NON_IDEMPOTENT_RETRY,
      )) as unknown as { id?: string }
      log.info("created dimacon customer from lexware", {
        lexwareContactId: candidate.contactId,
        dimaconCustomerId: created.id,
      })
      rows.push({ ...base, dimaconCustomerId: created.id, status: "created" })
    } catch (err) {
      const message = formatError(err)
      log.error("dimacon customer creation failed", {
        lexwareContactId: candidate.contactId,
        error: message,
      })
      rows.push({ ...base, status: "failed", reason: message })
    }
  }

  return { rows, blocked }
}

/**
 * Ein aktives Pflicht-Attribut ohne (befüllbare) Regel lässt JEDE Anlage an
 * Dimacon scheitern — einmal mit Abhilfe melden statt je Kunde einen Fehler.
 */
function unmappedRequiredMessage(
  required: readonly DimaconAttributeDef[],
  mapping: EntityMappingContext,
): string | undefined {
  const mapped = new Set(
    mapping.rules.flatMap((r) => (r.target.kind === "attribute" ? [r.target.attributeId] : [])),
  )
  const missing = required.filter((a) => !mapped.has(a.id) || attributeTargetProblem(a))
  if (missing.length === 0) return undefined
  const labels = missing
    .map((a) =>
      attributeTargetProblem(a)
        ? `„${a.label}" (${a.type}, von der Übernahme nicht befüllbar)`
        : `„${a.label}"`,
    )
    .join(", ")
  return (
    `Dimacon verlangt beim Anlegen eines Kunden das Pflicht-Attribut ${labels} — ` +
    `in der Feld-Zuordnung „Dimacon-Kunde (aus Lexware)" fehlt eine Quelle dafür. ` +
    `Keine Übernahme nach Dimacon in diesem Lauf.`
  )
}

function quoteLabels(attributes: readonly DimaconAttributeDef[]): string {
  return attributes.map((a) => `„${a.label}"`).join(", ")
}
