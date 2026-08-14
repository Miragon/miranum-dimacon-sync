import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { getClockInClient, getDimaconClient } from "../../lib/clients.js"
import { createLimit, withRetry } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import { log as rootLog } from "../../lib/log.js"
import type { Logger } from "../../lib/log.js"
import { loadEmployeesWithEmail } from "../shared/dimacon.js"
import { FIELD_CATALOG } from "../shared/field-catalog.js"
import { EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import { loadMappingContext } from "../shared/mapping-context.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { matchEmployees } from "./matcher.js"
import { EmployeeSyncer } from "./syncer.js"
import type {
  ClockinEmployeeInfo,
  EmployeeSyncError,
  EmployeeSyncInput,
  EmployeeSyncResult,
  EmployeeSyncRow,
} from "./types.js"

/**
 * Bidirektionaler Mitarbeiter-Abgleich Dimacon ⇄ Clockin: fehlende
 * Mitarbeiter werden auf beiden Seiten angelegt; bei gematchten Paaren
 * gewinnt Dimacon (Rückschreibung nur für fehlende Personalnummern);
 * Archivierungen werden nur gemeldet, nie propagiert.
 */
export async function runDimaconClockinEmployeeSync(
  input: EmployeeSyncInput,
): Promise<EmployeeSyncResult> {
  const startedAt = Date.now()
  const dryRun = input.dryRun ?? false
  const log = rootLog.child({ syncRun: { integration: "dimacon-clockin-employees", dryRun } })

  log.info("employee sync started")

  const errors: EmployeeSyncError[] = []
  const rows: EmployeeSyncRow[] = []

  const dimaconClient = getDimaconClient()
  const clockinClient = getClockInClient()

  let dimaconEmployees
  try {
    dimaconEmployees = await loadEmployeesWithEmail(dimaconClient)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load dimacon employees", { error: message })
    errors.push({ scope: "load", refId: "dimacon", message })
    return result(dryRun, startedAt, { dimacon: 0, clockin: 0, matched: 0 }, rows, errors)
  }

  // Feld-Zuordnung — ohne persistierte Regeln keine zusätzlichen API-Calls
  let mapping: EntityMappingContext
  try {
    const context = await loadMappingContext(dimaconClient, () => clockinClient, INTEGRATION_ID, [
      "employee",
    ])
    mapping = context.get("employee") ?? defaultEmployeeContext()
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load field mapping — falling back to defaults", { error: message })
    errors.push({
      scope: "mapping",
      message: `Feld-Zuordnung konnte nicht geladen werden — Standard-Regeln für diesen Lauf verwendet (${message})`,
    })
    mapping = defaultEmployeeContext()
  }
  const onMappingWarning = (message: string) => {
    log.warn("field mapping warning", { message })
    errors.push({ scope: "mapping", message })
  }

  let clockinEmployees
  try {
    clockinEmployees = await loadClockinEmployees(clockinClient, log, mapping.hasCustomTargets)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load clockin employees", { error: message })
    errors.push({ scope: "load", refId: "clockin", message })
    return result(
      dryRun,
      startedAt,
      { dimacon: dimaconEmployees.length, clockin: 0, matched: 0 },
      rows,
      errors,
    )
  }

  const outcome = matchEmployees(dimaconEmployees, clockinEmployees)
  log.info("employees matched", {
    dimacon: dimaconEmployees.length,
    clockin: clockinEmployees.length,
    matched: outcome.pairs.length,
    dimaconOnly: outcome.dimaconOnly.length,
    clockinOnly: outcome.clockinOnly.length,
    ambiguous: outcome.ambiguous.length,
  })

  for (const a of outcome.ambiguous) {
    rows.push({
      direction: "match",
      dimaconId: a.dimacon.id,
      name: `${a.dimacon.firstName} ${a.dimacon.lastName}`,
      status: "skipped",
      reason: a.reason,
    })
  }

  const limit = createLimit()
  const syncer = new EmployeeSyncer(
    dimaconClient,
    clockinClient,
    log,
    dryRun,
    mapping,
    onMappingWarning,
  )

  const collect =
    (refId: string, name: string, direction: EmployeeSyncRow["direction"]) => (err: unknown) => {
      const message = formatError(err)
      log.error("employee sync step failed", { refId, error: message })
      errors.push({ scope: "employee", refId, message })
      rows.push({ direction, name, status: "failed", reason: message })
    }

  await Promise.all([
    ...outcome.pairs.map((pair) =>
      limit(() =>
        syncer
          .alignPair(pair)
          .then((row) => void rows.push(row))
          .catch(
            collect(pair.dimacon.id, `${pair.dimacon.firstName} ${pair.dimacon.lastName}`, "match"),
          ),
      ),
    ),
    ...outcome.dimaconOnly.map((e) =>
      limit(() =>
        syncer
          .createInClockin(e)
          .then((row) => void rows.push(row))
          .catch(collect(e.id, `${e.firstName} ${e.lastName}`, "dimacon→clockin")),
      ),
    ),
    ...outcome.clockinOnly.map((c) =>
      limit(() =>
        syncer
          .createInDimacon(c)
          .then((row) => void rows.push(row))
          .catch(collect(String(c.id), `${c.firstName} ${c.lastName}`, "clockin→dimacon")),
      ),
    ),
  ])

  const final = result(
    dryRun,
    startedAt,
    {
      dimacon: dimaconEmployees.length,
      clockin: clockinEmployees.length,
      matched: outcome.pairs.length,
    },
    rows,
    errors,
  )
  log.info("employee sync finished", {
    durationMs: final.durationMs,
    rows: final.employees.length,
    errors: final.errors.length,
  })
  return final
}

const INTEGRATION_ID = "dimacon-clockin-employees"

function defaultEmployeeContext(): EntityMappingContext {
  return {
    entity: "employee",
    rules: FIELD_CATALOG.employee.defaultRules,
    catalog: FIELD_CATALOG.employee,
    discovery: EMPTY_DISCOVERY,
    isCustomized: false,
    hasCustomTargets: false,
  }
}

interface ClockinEmployeeRow {
  id?: number
  first_name?: string
  last_name?: string
  personnel_number?: string
  email?: string | null
  phone_work?: string | null
  customFields?: { custom_field_id?: number; value?: string | null }[]
}

async function loadClockinEmployees(
  client: ClockInClient,
  log: Logger,
  withCustomFields: boolean,
): Promise<ClockinEmployeeInfo[]> {
  // Custom-Field-Werte gibt es nur über die Search-API (includes-Body) —
  // ohne Custom-Ziele reicht die einfache Liste.
  const response = (await withRetry(() =>
    withCustomFields
      ? clockin.searchForEmployees({
          client,
          body: { includes: [{ relation: "customFields" }] },
        })
      : clockin.getAListOfEmployees({ client }),
  )) as unknown as {
    data?: ClockinEmployeeRow[]
    meta?: { last_page?: number; per_page?: number; total?: number }
  }

  const meta = response.meta
  if (meta?.last_page && meta.last_page > 1) {
    log.warn("clockin employees exceed first page; sync may be incomplete", {
      total: meta.total,
      lastPage: meta.last_page,
      perPage: meta.per_page,
    })
  }

  return (response.data ?? [])
    .filter((r): r is ClockinEmployeeRow & { id: number } => r.id !== undefined)
    .map((r) => ({
      id: r.id,
      firstName: r.first_name ?? "",
      lastName: r.last_name ?? "",
      personnelNumber: r.personnel_number || undefined,
      email: r.email ?? undefined,
      phoneWork: r.phone_work ?? undefined,
      raw: r as unknown as Record<string, unknown>,
      customFieldValues: r.customFields,
    }))
}

function result(
  dryRun: boolean,
  startedAt: number,
  counts: EmployeeSyncResult["counts"],
  employees: EmployeeSyncRow[],
  errors: EmployeeSyncError[],
): EmployeeSyncResult {
  return {
    dryRun,
    durationMs: Date.now() - startedAt,
    counts,
    employees,
    errors,
  }
}
