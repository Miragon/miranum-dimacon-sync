import type { Client as DimaconClient } from "@miragon/client-dimacon"
import type { Client as LexofficeClient } from "@miragon/client-lexoffice"
import { createLimit } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import type { Logger } from "../../lib/log.js"
import { withPhase } from "../../lib/metrics.js"
import type { IntegrationRunContext } from "../types.js"
import { loadAllCustomers } from "../shared/dimacon.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { loadMappingContext } from "../shared/mapping-context.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { duplicateKeys } from "../shared/matching.js"
import { addDays, todayInBerlin } from "../shared/time.js"
import { CustomerAligner } from "./aligner.js"
import { loadLexwareContactIndex } from "./contact-index.js"
import type { LexwareContactIndex } from "./contact-index.js"
import { importFromLexware } from "./importer.js"
import { DEFAULT_LEXOFFICE_STEPS } from "./types.js"
import type {
  CustomerAlignRow,
  CustomerImportRow,
  CustomerSyncError,
  CustomerSyncInput,
  CustomerSyncResult,
  LexofficeSyncSteps,
} from "./types.js"
import { IMPORT_WINDOW_DAYS, loadVoucherCandidates } from "./voucher-candidates.js"

/**
 * Kunden-Sync Dimacon → Lexware Office über den GESAMTEN Kundenbestand:
 * für jeden Dimacon-Kunden wird der Lexware-Kontakt sichergestellt und die
 * Dimacon-Kundennummer an die Lexware-Nummer angeglichen. Ein Live-Lauf
 * legt fehlende Lexware-Kontakte für alle Dimacon-Kunden an — vor dem
 * ersten Live-Lauf einen dry-run prüfen.
 *
 * Opt-in `importFromLexware`: danach die Gegenrichtung für Kontakte mit
 * aktuellem Angebot/Auftragsbestätigung (import-policy.ts). Sie läuft
 * bewusst im SELBEN Lauf hinter dem Vorwärts-Abgleich — unter einem Mutex
 * und mit dessen Zuordnungen; als eigene Integration könnten beide
 * Richtungen parallel denselben Kunden anlegen.
 */
export async function runDimaconLexofficeSync(
  ctx: IntegrationRunContext,
  input: CustomerSyncInput,
): Promise<CustomerSyncResult> {
  const startedAt = Date.now()
  const dryRun = input.dryRun ?? false
  let steps = input.steps ?? DEFAULT_LEXOFFICE_STEPS
  const log = ctx.log.child({ syncRun: { integration: "dimacon-lexoffice", dryRun, steps } })

  log.info("customer sync started")

  const errors: CustomerSyncError[] = []
  const rows: CustomerAlignRow[] = []
  const imports: CustomerImportRow[] = []

  const dimaconClient = await ctx.clients.dimacon()
  const lexofficeClient = await ctx.clients.lexoffice()

  // Feld-Zuordnung — ohne persistierte Regeln keine zusätzlichen API-Calls.
  // Safe-Mode bei Ladefehler: keine Kontakt-Anlagen mit unklarer Zuordnung,
  // das Nummern-Alignment braucht keine Zuordnung und läuft weiter.
  // Clockin bleibt ein Lazy-Getter: er wird für lexofficeContact nie
  // aufgerufen — der Mandant braucht dafür keine Clockin-Credentials.
  let mapping: EntityMappingContext | undefined
  try {
    const context = await withPhase("mapping", () =>
      loadMappingContext({
        dimaconClient,
        getClockinClient: () => ctx.clients.clockin(),
        entities: ["lexofficeContact"],
        getFieldMapping: ctx.getFieldMapping,
      }),
    )
    mapping = context.get("lexofficeContact")
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

  if (!steps.createContacts && !steps.alignNumbers && !steps.importFromLexware) {
    log.info("all steps disabled — nothing to do")
    return result(dryRun, steps, startedAt, rows, imports, errors)
  }

  let customers
  try {
    customers = await withPhase("customers", () => loadAllCustomers(dimaconClient))
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load customers", { error: message })
    errors.push({ scope: "customers", message })
    return result(dryRun, steps, startedAt, rows, imports, errors)
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

  // Ein leerer Dimacon-Bestand beendet den Lauf nur ohne Übernahme — für die
  // Gegenrichtung ist genau das der Fall, in dem es am meisten zu tun gibt.
  if (customers.length === 0 && !steps.importFromLexware) {
    log.info("no customers in dimacon — nothing to sync")
    return result(dryRun, steps, startedAt, rows, imports, errors)
  }

  // Voll-Import der Lexware-Kontakte: aus einer Suche JE KUNDE werden ein
  // paar Seitenabrufe. Scheitert er, läuft der Sync mit dem bisherigen
  // Verhalten (Serversuche je Kunde) weiter — nur langsamer.
  let contactIndex: LexwareContactIndex | undefined
  try {
    contactIndex = await withPhase("contact-index", () =>
      loadLexwareContactIndex(lexofficeClient, log),
    )
  } catch (err) {
    const message = formatError(err)
    log.warn("lexware contact index failed — falling back to per-customer lookups", {
      error: message,
    })
    errors.push({
      scope: "customers",
      message: `Lexware-Kontakte konnten nicht vorab geladen werden — Auflösung läuft je Kunde einzeln (${message})`,
    })
  }
  if (!contactIndex) {
    log.info("running without lexware contact index — per-customer lookups")
  }

  // Jede Task fasst Lexware UND Dimacon an — maßgeblich ist das strengste
  // beteiligte System (Lexware Office: 2 req/s laut Doku).
  const limit = createLimit("lexoffice")
  const aligner = new CustomerAligner(
    dimaconClient,
    lexofficeClient,
    log,
    dryRun,
    steps,
    mapping,
    onMappingWarning,
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

  if (steps.importFromLexware) {
    imports.push(
      ...(await withPhase("import", () =>
        runImport({
          lexofficeClient,
          dimaconClient,
          log,
          dryRun,
          contactIndex,
          customers,
          rows,
          errors,
          getFieldMapping: ctx.getFieldMapping,
          onMappingWarning,
        }),
      )),
    )
  }

  const final = result(dryRun, steps, startedAt, rows, imports, errors)
  log.info("customer sync finished", {
    durationMs: final.durationMs,
    customers: final.customers.length,
    imports: final.imports.length,
    errors: final.errors.length,
  })
  return final
}

/**
 * Gegenrichtung Lexware → Dimacon. Fail-closed: ohne VOLLSTÄNDIGEN
 * Kontakt-Index (Fallback auf die Suche je Kunde) oder ohne vollständige
 * Belegliste wird nichts angelegt — ein Kontakt auf einer nicht geladenen
 * Seite gälte sonst als unbekannt.
 */
async function runImport(opts: {
  lexofficeClient: LexofficeClient
  dimaconClient: DimaconClient
  log: Logger
  dryRun: boolean
  contactIndex: LexwareContactIndex | undefined
  customers: readonly DimaconCustomerInfo[]
  rows: readonly CustomerAlignRow[]
  errors: CustomerSyncError[]
  getFieldMapping: IntegrationRunContext["getFieldMapping"]
  onMappingWarning: (message: string) => void
}): Promise<CustomerImportRow[]> {
  const { lexofficeClient, log, errors, contactIndex } = opts
  if (!contactIndex) {
    errors.push({
      scope: "import",
      message:
        "Lexware-Kontakte nicht vollständig geladen — keine Übernahme nach Dimacon in diesem Lauf",
    })
    return []
  }

  const from = addDays(todayInBerlin(), -IMPORT_WINDOW_DAYS)
  let candidates
  try {
    candidates = await loadVoucherCandidates(lexofficeClient, from, log)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load lexware vouchers", { error: message })
    errors.push({
      scope: "import",
      message: `Lexware-Belege konnten nicht geladen werden — keine Übernahme nach Dimacon (${message})`,
    })
    return []
  }
  if (!candidates) {
    errors.push({
      scope: "import",
      message:
        "Lexware-Belege nicht vollständig geladen — keine Übernahme nach Dimacon in diesem Lauf",
    })
    return []
  }
  log.info("lexware import candidates loaded", { from, candidates: candidates.length })
  if (candidates.length === 0) return []

  // Ohne Zuordnung + Discovery sind die Pflicht-Attribute unbekannt — dann
  // lieber gar nicht anlegen als jede Anlage einzeln an Dimacon scheitern lassen.
  let mapping: EntityMappingContext | undefined
  try {
    const context = await loadMappingContext({
      dimaconClient: opts.dimaconClient,
      // Wird für dimaconCustomer nie aufgerufen — der Mandant braucht dafür
      // keine Clockin-Credentials.
      getClockinClient: () => {
        throw new Error("dimaconCustomer braucht keinen Clockin-Client")
      },
      entities: ["dimaconCustomer"],
      getFieldMapping: opts.getFieldMapping,
    })
    mapping = context.get("dimaconCustomer")
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load dimaconCustomer mapping", { error: message })
    errors.push({
      scope: "import",
      message: `Feld-Zuordnung bzw. Dimacon-Kunden-Attribute konnten nicht geladen werden — keine Übernahme nach Dimacon (${message})`,
    })
    return []
  }
  if (!mapping) return []

  const claimed = new Set(
    opts.rows.map((r) => r.lexwareContactId).filter((id): id is string => Boolean(id)),
  )
  const outcome = await importFromLexware({
    dimaconClient: opts.dimaconClient,
    log,
    dryRun: opts.dryRun,
    candidates,
    contactById: (id) => contactIndex.byId(id),
    customers: opts.customers,
    claimed,
    mapping,
    onMappingWarning: opts.onMappingWarning,
  })
  if (outcome.blocked) {
    log.warn("lexware import blocked", { reason: outcome.blocked })
    errors.push({ scope: "import", message: outcome.blocked })
  }
  return outcome.rows
}

function result(
  dryRun: boolean,
  steps: LexofficeSyncSteps,
  startedAt: number,
  customers: CustomerAlignRow[],
  imports: CustomerImportRow[],
  errors: CustomerSyncError[],
): CustomerSyncResult {
  return {
    dryRun,
    steps,
    durationMs: Date.now() - startedAt,
    customers,
    imports,
    errors,
  }
}
