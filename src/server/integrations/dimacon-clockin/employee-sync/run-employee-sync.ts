import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { createLimit, withRetry } from "../../../lib/concurrency.js"
import { formatError } from "../../../lib/errors.js"
import type { Logger } from "../../../lib/log.js"
import { loadEmployeesWithEmail } from "../../shared/dimacon.js"
import type { EntityMappingContext } from "../../shared/mapping-context.js"
import { matchEmployees } from "./matcher.js"
import { EmployeeSyncer } from "./syncer.js"
import type { ClockinEmployeeInfo, EmployeeSyncCounts, EmployeeSyncRow } from "./types.js"

export interface EmployeeSyncError {
  scope: "load" | "employee" | "mapping"
  refId?: string
  message: string
}

export interface EmployeeSyncOutcome {
  counts: EmployeeSyncCounts
  rows: EmployeeSyncRow[]
  errors: EmployeeSyncError[]
  /** dimaconEmployeeId → clockinEmployeeId — seedet den Zuordnungs-Matcher */
  pairs: Map<string, number>
}

/**
 * Bidirektionaler Mitarbeiter-Stammdaten-Abgleich Dimacon ⇄ Clockin:
 * fehlende Mitarbeiter werden auf beiden Seiten angelegt; bei gematchten
 * Paaren gewinnt Dimacon (Rückschreibung nur für fehlende Personalnummern);
 * Archivierungen werden nur gemeldet. Läuft als Schritt des
 * dimacon-clockin-Syncs VOR der Tagesplanung, damit frisch angelegte
 * Mitarbeiter sofort zuordenbar sind.
 */
export async function runEmployeeSync(
  dimaconClient: DimaconClient,
  clockinClient: ClockInClient,
  mapping: EntityMappingContext,
  dryRun: boolean,
  log: Logger,
  onMappingWarning: (message: string) => void,
): Promise<EmployeeSyncOutcome> {
  const errors: EmployeeSyncError[] = []
  const rows: EmployeeSyncRow[] = []
  const pairs = new Map<string, number>()

  let dimaconEmployees
  try {
    dimaconEmployees = await loadEmployeesWithEmail(dimaconClient)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load dimacon employees", { error: message })
    errors.push({ scope: "load", refId: "dimacon", message })
    return { counts: { dimacon: 0, clockin: 0, matched: 0 }, rows, errors, pairs }
  }

  let clockinEmployees
  try {
    clockinEmployees = await loadClockinEmployees(clockinClient, log, mapping.hasCustomTargets)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load clockin employees", { error: message })
    errors.push({ scope: "load", refId: "clockin", message })
    return {
      counts: { dimacon: dimaconEmployees.length, clockin: 0, matched: 0 },
      rows,
      errors,
      pairs,
    }
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

  for (const pair of outcome.pairs) {
    pairs.set(pair.dimacon.id, pair.clockin.id)
  }

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
          .then((row) => {
            rows.push(row)
            // Live angelegte Mitarbeiter sind sofort zuordenbar
            if (row.clockinId !== undefined) pairs.set(e.id, row.clockinId)
          })
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

  return {
    counts: {
      dimacon: dimaconEmployees.length,
      clockin: clockinEmployees.length,
      matched: outcome.pairs.length,
    },
    rows,
    errors,
    pairs,
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
