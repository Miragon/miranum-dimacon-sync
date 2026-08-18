import { getClockInClient, getDimaconClient, getLexofficeClient } from "../../lib/clients.js"
import { createLimit } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import { log as rootLog } from "../../lib/log.js"
import { loadAllCustomers } from "../shared/dimacon.js"
import { loadMappingContext } from "../shared/mapping-context.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { CustomerAligner } from "./aligner.js"
import { DEFAULT_LEXOFFICE_STEPS } from "./types.js"
import type {
  CustomerAlignRow,
  CustomerSyncError,
  CustomerSyncInput,
  CustomerSyncResult,
  LexofficeSyncSteps,
} from "./types.js"

/**
 * Kunden-Sync Dimacon → Lexware Office über den GESAMTEN Kundenbestand:
 * für jeden Dimacon-Kunden wird der Lexware-Kontakt sichergestellt und die
 * Dimacon-Kundennummer an die Lexware-Nummer angeglichen. Ein Live-Lauf
 * legt fehlende Lexware-Kontakte für alle Dimacon-Kunden an — vor dem
 * ersten Live-Lauf einen dry-run prüfen.
 */
export async function runDimaconLexofficeSync(
  input: CustomerSyncInput,
): Promise<CustomerSyncResult> {
  const startedAt = Date.now()
  const dryRun = input.dryRun ?? false
  let steps = input.steps ?? DEFAULT_LEXOFFICE_STEPS
  const log = rootLog.child({ syncRun: { integration: "dimacon-lexoffice", dryRun, steps } })

  log.info("customer sync started")

  const errors: CustomerSyncError[] = []
  const rows: CustomerAlignRow[] = []

  const dimaconClient = getDimaconClient()
  const lexofficeClient = getLexofficeClient()

  // Feld-Zuordnung — ohne persistierte Regeln keine zusätzlichen API-Calls.
  // Safe-Mode bei Ladefehler: keine Kontakt-Anlagen mit unklarer Zuordnung,
  // das Nummern-Alignment braucht keine Zuordnung und läuft weiter.
  let mapping: EntityMappingContext | undefined
  try {
    const context = await loadMappingContext(dimaconClient, getClockInClient, "dimacon-lexoffice", [
      "lexofficeContact",
    ])
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

  if (!steps.createContacts && !steps.alignNumbers) {
    log.info("all steps disabled — nothing to do")
    return result(dryRun, steps, startedAt, rows, errors)
  }

  let customers
  try {
    customers = await loadAllCustomers(dimaconClient)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load customers", { error: message })
    errors.push({ scope: "customers", message })
    return result(dryRun, steps, startedAt, rows, errors)
  }

  log.info("customers loaded", { customers: customers.length })

  if (customers.length === 0) {
    log.info("no customers in dimacon — nothing to sync")
    return result(dryRun, steps, startedAt, rows, errors)
  }

  const limit = createLimit()
  const aligner = new CustomerAligner(
    dimaconClient,
    lexofficeClient,
    log,
    dryRun,
    steps,
    mapping,
    onMappingWarning,
  )

  await Promise.all(
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
  steps: LexofficeSyncSteps,
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
