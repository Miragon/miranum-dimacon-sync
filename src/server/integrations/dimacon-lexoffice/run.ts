import { getDimaconClient, getLexofficeClient } from "../../lib/clients.js"
import { createLimit } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import { log as rootLog } from "../../lib/log.js"
import { loadAppointments, loadCustomersById, loadJobBundles } from "../shared/dimacon.js"
import { todayInBerlin } from "../shared/time.js"
import { CustomerAligner } from "./aligner.js"
import type {
  CustomerAlignRow,
  CustomerSyncError,
  CustomerSyncInput,
  CustomerSyncResult,
} from "./types.js"

/**
 * Kunden-Sync Dimacon → Lexware Office: für alle Kunden, die an dem Tag in
 * der Dimacon-Planung auftauchen, wird der Lexware-Kontakt sichergestellt
 * und die Dimacon-Kundennummer an die Lexware-Nummer angeglichen.
 */
export async function runDimaconLexofficeSync(
  input: CustomerSyncInput,
): Promise<CustomerSyncResult> {
  const startedAt = Date.now()
  const date = input.date ?? todayInBerlin()
  const dryRun = input.dryRun ?? false
  const log = rootLog.child({ syncRun: { integration: "dimacon-lexoffice", date, dryRun } })

  log.info("customer sync started")

  const errors: CustomerSyncError[] = []
  const rows: CustomerAlignRow[] = []

  const dimaconClient = getDimaconClient()
  const lexofficeClient = getLexofficeClient()

  let loaded
  try {
    loaded = await loadAppointments(dimaconClient, date)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load appointments", { error: message })
    errors.push({ scope: "appointments", message })
    return result(date, dryRun, startedAt, rows, errors)
  }

  if (loaded.jobIds.length === 0) {
    log.info("no appointments for date — nothing to sync")
    return result(date, dryRun, startedAt, rows, errors)
  }

  const limit = createLimit()

  let bundles
  try {
    bundles = await loadJobBundles(dimaconClient, loaded.jobIds, limit)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load jobs", { error: message })
    errors.push({ scope: "jobs", message })
    return result(date, dryRun, startedAt, rows, errors)
  }

  let customers
  try {
    const customerIds = [...new Set(bundles.map((b) => b.customerId))]
    customers = await loadCustomersById(dimaconClient, customerIds, limit)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load customers", { error: message })
    errors.push({ scope: "customers", message })
    return result(date, dryRun, startedAt, rows, errors)
  }

  log.info("customers loaded", { customers: customers.length, jobs: loaded.jobIds.length })

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

  const final = result(date, dryRun, startedAt, rows, errors)
  log.info("customer sync finished", {
    durationMs: final.durationMs,
    customers: final.customers.length,
    errors: final.errors.length,
  })
  return final
}

function result(
  date: string,
  dryRun: boolean,
  startedAt: number,
  customers: CustomerAlignRow[],
  errors: CustomerSyncError[],
): CustomerSyncResult {
  return {
    date,
    dryRun,
    durationMs: Date.now() - startedAt,
    customers,
    errors,
  }
}
