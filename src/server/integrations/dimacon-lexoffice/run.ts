import { getDimaconClient, getLexofficeClient } from "../../lib/clients.js"
import { createLimit } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import { log as rootLog } from "../../lib/log.js"
import { loadAllCustomers } from "../shared/dimacon.js"
import { CustomerAligner } from "./aligner.js"
import type {
  CustomerAlignRow,
  CustomerSyncError,
  CustomerSyncInput,
  CustomerSyncResult,
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
  const log = rootLog.child({ syncRun: { integration: "dimacon-lexoffice", dryRun } })

  log.info("customer sync started")

  const errors: CustomerSyncError[] = []
  const rows: CustomerAlignRow[] = []

  const dimaconClient = getDimaconClient()
  const lexofficeClient = getLexofficeClient()

  let customers
  try {
    customers = await loadAllCustomers(dimaconClient)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load customers", { error: message })
    errors.push({ scope: "customers", message })
    return result(dryRun, startedAt, rows, errors)
  }

  log.info("customers loaded", { customers: customers.length })

  if (customers.length === 0) {
    log.info("no customers in dimacon — nothing to sync")
    return result(dryRun, startedAt, rows, errors)
  }

  const limit = createLimit()
  const aligner = new CustomerAligner(dimaconClient, lexofficeClient, log, dryRun)

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

  const final = result(dryRun, startedAt, rows, errors)
  log.info("customer sync finished", {
    durationMs: final.durationMs,
    customers: final.customers.length,
    errors: final.errors.length,
  })
  return final
}

function result(
  dryRun: boolean,
  startedAt: number,
  customers: CustomerAlignRow[],
  errors: CustomerSyncError[],
): CustomerSyncResult {
  return {
    dryRun,
    durationMs: Date.now() - startedAt,
    customers,
    errors,
  }
}
