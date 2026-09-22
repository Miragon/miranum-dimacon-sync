import { createLimit } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import { withPhase } from "../../lib/metrics.js"
import type { IntegrationRunContext } from "../types.js"
import { loadAllCustomers } from "../shared/dimacon.js"
import { loadMappingContext } from "../shared/mapping-context.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { duplicateKeys } from "../shared/matching.js"
import { SevdeskAligner } from "./aligner.js"
import { loadSevdeskContactIndex } from "./contact-index.js"
import type { SevdeskContactIndex } from "./contact-index.js"
import { DEFAULT_SEVDESK_STEPS } from "./types.js"
import type {
  CustomerAlignRow,
  CustomerSyncError,
  CustomerSyncInput,
  CustomerSyncResult,
  SevdeskSyncSteps,
} from "./types.js"

/**
 * Kunden-Sync Dimacon → sevDesk über den GESAMTEN Kundenbestand: für jeden
 * Dimacon-Kunden wird der sevDesk-Kontakt sichergestellt und die
 * Dimacon-Kundennummer an die sevDesk-Nummer angeglichen. Ein Live-Lauf
 * legt fehlende sevDesk-Kontakte für alle Dimacon-Kunden an — vor dem
 * ersten Live-Lauf einen dry-run prüfen.
 *
 * Bewusst OHNE Gegenrichtung (anders als dimacon-lexoffice mit seiner
 * Opt-in-Übernahme) — bei Bedarf später nach demselben Muster ergänzen.
 */
export async function runDimaconSevdeskSync(
  ctx: IntegrationRunContext,
  input: CustomerSyncInput,
): Promise<CustomerSyncResult> {
  const startedAt = Date.now()
  const dryRun = input.dryRun ?? false
  let steps = input.steps ?? DEFAULT_SEVDESK_STEPS
  const log = ctx.log.child({ syncRun: { integration: "dimacon-sevdesk", dryRun, steps } })

  log.info("customer sync started")

  const errors: CustomerSyncError[] = []
  const rows: CustomerAlignRow[] = []

  const dimaconClient = await ctx.clients.dimacon()
  const sevdeskClient = await ctx.clients.sevdesk()

  // Feld-Zuordnung — ohne persistierte Regeln keine zusätzlichen API-Calls.
  // Safe-Mode bei Ladefehler: keine Kontakt-Anlagen mit unklarer Zuordnung,
  // das Nummern-Alignment braucht keine Zuordnung und läuft weiter.
  // Clockin bleibt ein Lazy-Getter: er wird für sevdeskContact nie
  // aufgerufen — der Mandant braucht dafür keine Clockin-Credentials.
  let mapping: EntityMappingContext | undefined
  try {
    const context = await withPhase("mapping", () =>
      loadMappingContext({
        dimaconClient,
        getClockinClient: () => ctx.clients.clockin(),
        entities: ["sevdeskContact"],
        getFieldMapping: ctx.getFieldMapping,
      }),
    )
    mapping = context.get("sevdeskContact")
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load field mapping — disabling contact creation for this run", {
      error: message,
    })
    errors.push({
      scope: "mapping",
      message: `Feld-Zuordnung konnte nicht geladen werden — Kontakt-Anlage für diesen Lauf deaktiviert (${message})`,
    })
    steps = { ...steps, createContacts: false }
  }
  const onMappingWarning = (message: string) => {
    log.warn("field mapping warning", { message })
    errors.push({ scope: "mapping", message })
  }

  if (!steps.createContacts && !steps.alignNumbers) {
    log.info("all steps disabled — nothing to do")
    return result(dryRun, steps, startedAt, rows, errors)
  }

  let customers
  try {
    customers = await withPhase("customers", () => loadAllCustomers(dimaconClient))
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load customers", { error: message })
    errors.push({ scope: "customers", message })
    return result(dryRun, steps, startedAt, rows, errors)
  }

  // Gleichnamige bzw. gleichnummerierte Dimacon-Kunden VORAB erkennen: für
  // sie ist der jeweilige Schlüssel wertlos. Ohne diesen Vorab-Check würden
  // zwei gleichnamige Kunden parallel (p-limit) denselben Kontakt greifen
  // oder zwei Kontakte anlegen.
  const duplicateDimaconNames = duplicateKeys(customers, (c) => c.name)
  const duplicateDimaconNumbers = duplicateKeys(customers, (c) => c.customerNumber)

  log.info("customers loaded", {
    customers: customers.length,
    duplicateNames: duplicateDimaconNames.size,
    duplicateNumbers: duplicateDimaconNumbers.size,
  })
  if (duplicateDimaconNames.size > 0 || duplicateDimaconNumbers.size > 0) {
    log.warn("gleichnamige bzw. gleichnummerierte dimacon-kunden", {
      names: duplicateDimaconNames.size,
      numbers: duplicateDimaconNumbers.size,
    })
  }

  if (customers.length === 0) {
    log.info("no customers in dimacon — nothing to sync")
    return result(dryRun, steps, startedAt, rows, errors)
  }

  // Voll-Import der sevDesk-Kontakte: aus einer Suche JE KUNDE werden ein
  // paar Seitenabrufe. Scheitert er, läuft der Sync mit Serversuche je
  // Kunde weiter — nur langsamer.
  let contactIndex: SevdeskContactIndex | undefined
  try {
    contactIndex = await withPhase("contact-index", () =>
      loadSevdeskContactIndex(sevdeskClient, log),
    )
  } catch (err) {
    const message = formatError(err)
    log.warn("sevdesk contact index failed — falling back to per-customer lookups", {
      error: message,
    })
    errors.push({
      scope: "customers",
      message: `sevDesk-Kontakte konnten nicht vorab geladen werden — Auflösung läuft je Kunde einzeln (${message})`,
    })
  }
  if (!contactIndex) {
    log.info("running without sevdesk contact index — per-customer lookups")
  }

  // Jede Task fasst sevDesk UND Dimacon an — maßgeblich ist das strengste
  // beteiligte System (sevDesk: Limit unbekannt, konservativ gedrosselt).
  const limit = createLimit("sevdesk")
  const aligner = new SevdeskAligner(
    dimaconClient,
    sevdeskClient,
    log,
    dryRun,
    steps,
    mapping,
    onMappingWarning,
    (customerId, message) => {
      log.warn("sevdesk contact created with partial failure", { customerId, message })
      errors.push({ scope: "customer", refId: customerId, message })
    },
    { names: duplicateDimaconNames, numbers: duplicateDimaconNumbers },
    contactIndex,
  )

  await withPhase("align", () =>
    Promise.all(
      customers.map((customer) =>
        limit(async () => {
          try {
            rows.push(await aligner.align(customer))
          } catch (err) {
            const message = formatError(err)
            log.error("customer align failed", { dimaconCustomerId: customer.id, error: message })
            errors.push({ scope: "customer", refId: customer.id, message })
            rows.push({
              dimaconCustomerId: customer.id,
              name: customer.name,
              status: "failed",
              reason: message,
            })
          }
        }),
      ),
    ),
  )

  const final = result(dryRun, steps, startedAt, rows, errors)
  log.info("customer sync finished", {
    durationMs: final.durationMs,
    customers: final.customers.length,
    errors: final.errors.length,
  })
  return final
}

function result(
  dryRun: boolean,
  steps: SevdeskSyncSteps,
  startedAt: number,
  customers: CustomerAlignRow[],
  errors: CustomerSyncError[],
): CustomerSyncResult {
  return {
    dryRun,
    steps,
    durationMs: Date.now() - startedAt,
    customers,
    errors,
  }
}
