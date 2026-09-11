import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { createLimit, withRetry } from "../../../lib/concurrency.js"
import { formatError } from "../../../lib/errors.js"
import type { Logger } from "../../../lib/log.js"
import { clockinPageQuery, loadAllClockinPages } from "../../shared/clockin-pages.js"
import type { ClockinPage } from "../../shared/clockin-pages.js"
import { loadEmployeesWithEmail } from "../../shared/dimacon.js"
import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import type { EntityMappingContext } from "../../shared/mapping-context.js"
import { todayInBerlin } from "../../shared/time.js"
import {
  CREATION_DISABLED_REASON,
  INCOMPLETE_BASE_REASON,
  buildLooseNameIndex,
  creationBlockReason,
} from "./creation-policy.js"
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

export interface EmployeeSyncOptions {
  dryRun: boolean
  /** `steps.employeeCreateInDimacon` — Anlage Clockin → Dimacon, Default aus */
  createInDimacon: boolean
}

/**
 * Deckel gegen jsonb-Bloat: `recordRun` kappt Ergebnisse über 512 KB komplett.
 * Mehr als 200 Einzelbegründungen bringen keinen Erkenntnisgewinn.
 */
const MAX_SKIPPED_ROWS = 200

/**
 * Deckel für die Gründe-Verteilung im Log: die häufigsten Gründe genügen, um
 * einen Lauf einzuordnen — die Liste soll keine Log-Zeile sprengen.
 */
const MAX_LOGGED_REASONS = 20

/**
 * Bidirektionaler Mitarbeiter-Stammdaten-Abgleich Dimacon ⇄ Clockin:
 * fehlende Mitarbeiter werden auf beiden Seiten angelegt; bei gematchten
 * Paaren gewinnt Dimacon (Rückschreibung nur für fehlende Personalnummern);
 * Archivierungen werden nur gemeldet. Läuft als Schritt des
 * dimacon-clockin-Syncs VOR der Tagesplanung, damit frisch angelegte
 * Mitarbeiter sofort zuordenbar sind.
 *
 * Fail-safe (Issue #17): Die Anlage Clockin → Dimacon läuft nur mit
 * ausdrücklichem Schalter und Relevanzfilter, und wurde der Clockin-Bestand
 * unvollständig geladen, legt der Lauf in KEINER Richtung Mitarbeiter an —
 * ein unvollständiger Vergleich erzeugt sonst Dubletten.
 */
export async function runEmployeeSync(
  dimaconClient: DimaconClient,
  clockinClient: ClockInClient,
  mapping: EntityMappingContext,
  options: EmployeeSyncOptions,
  log: Logger,
  onMappingWarning: (message: string) => void,
  /**
   * Bereits geladene Dimacon-Mitarbeiter. Der Orchestrator lädt sie einmal
   * für Stammdaten-Abgleich UND Tagesplanung — das spart je Lauf ein
   * `getAllEmployees` + `getAllUsers`.
   */
  preloadedDimaconEmployees?: readonly DimaconEmployeeFull[],
): Promise<EmployeeSyncOutcome> {
  const errors: EmployeeSyncError[] = []
  const rows: EmployeeSyncRow[] = []
  const pairs = new Map<string, number>()

  let dimaconEmployees
  try {
    dimaconEmployees = preloadedDimaconEmployees
      ? [...preloadedDimaconEmployees]
      : await loadEmployeesWithEmail(dimaconClient)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load dimacon employees", { error: message })
    errors.push({ scope: "load", refId: "dimacon", message })
    return { counts: { dimacon: 0, clockin: 0, matched: 0 }, rows, errors, pairs }
  }

  let load: ClockinEmployeeLoad
  try {
    load = await loadClockinEmployees(clockinClient, log, mapping.hasCustomTargets)
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

  const clockinEmployees = load.employees
  // Unvollständige Vergleichsbasis ⇒ keine Anlage, in KEINER Richtung.
  const mayCreate = load.complete
  if (!load.complete) {
    errors.push({
      scope: "load",
      refId: "clockin",
      message: `Clockin-Mitarbeiterliste unvollständig geladen (${load.reason ?? "Grund unbekannt"}) — dieser Lauf legt keine Mitarbeiter an`,
    })
  }

  const outcome = matchEmployees(dimaconEmployees, clockinEmployees)

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

  // Anlage-Policy Clockin → Dimacon: Schalter, Vollständigkeit, Matcher-Sperren
  // und Relevanzkriterien entscheiden — nichts wird still angelegt oder still
  // verworfen.
  const policy = {
    enabled: options.createInDimacon,
    baseComplete: mayCreate,
    blocked: outcome.blockedClockinIds,
    looseNames: buildLooseNameIndex(dimaconEmployees),
    today: todayInBerlin(),
  }
  const createCandidates: ClockinEmployeeInfo[] = []
  const notCreated: { employee: ClockinEmployeeInfo; reason: string }[] = []
  for (const c of outcome.clockinOnly) {
    const reason = creationBlockReason(c, policy)
    if (reason === null) createCandidates.push(c)
    else notCreated.push({ employee: c, reason })
  }

  log.info("employees matched", {
    dimacon: dimaconEmployees.length,
    clockin: clockinEmployees.length,
    pages: load.pages,
    complete: load.complete,
    matched: outcome.pairs.length,
    dimaconOnly: outcome.dimaconOnly.length,
    clockinOnly: outcome.clockinOnly.length,
    ambiguous: outcome.ambiguous.length,
    blocked: outcome.blockedClockinIds.size,
    notCreated: notCreated.length,
  })

  if (notCreated.length > 0) {
    // Das Ergebnis führt nur die ersten MAX_SKIPPED_ROWS Kandidaten einzeln
    // auf — die Verteilung der Gründe bleibt hier für jeden Lauf sichtbar.
    log.info("employees not created in dimacon", {
      total: notCreated.length,
      byReason: countByReason(notCreated),
    })
  }

  rows.push(...notCreatedRows(notCreated, policy))

  if (!mayCreate && outcome.dimaconOnly.length > 0) {
    rows.push({
      direction: "dimacon→clockin",
      name: `(${candidateLabel(outcome.dimaconOnly.length)})`,
      status: "skipped",
      reason: "Clockin-Bestand unvollständig geladen — nicht in Clockin angelegt",
    })
  }

  // Getrennte Limits je Zielsystem: die Anlage-Richtung Clockin → Dimacon
  // darf sich nicht denselben Slot-Vorrat mit den Clockin-Schreibzugriffen
  // teilen, sonst blockieren sich die Richtungen gegenseitig.
  const clockinLimit = createLimit("clockin")
  const dimaconLimit = createLimit("dimacon")
  const syncer = new EmployeeSyncer(
    dimaconClient,
    clockinClient,
    log,
    options.dryRun,
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
      clockinLimit(() =>
        syncer
          .alignPair(pair)
          .then((row) => void rows.push(row))
          .catch(
            collect(pair.dimacon.id, `${pair.dimacon.firstName} ${pair.dimacon.lastName}`, "match"),
          ),
      ),
    ),
    ...(mayCreate ? outcome.dimaconOnly : []).map((e) =>
      clockinLimit(() =>
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
    ...createCandidates.map((c) =>
      dimaconLimit(() =>
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

/**
 * Globale Gründe (Schalter aus, Basis unvollständig) treffen jeden Kandidaten
 * gleich — dafür genügt EINE Sammelzeile. Individuelle Gründe kommen pro
 * Kandidat, gedeckelt gegen jsonb-Bloat.
 */
function notCreatedRows(
  notCreated: { employee: ClockinEmployeeInfo; reason: string }[],
  policy: { enabled: boolean; baseComplete: boolean },
): EmployeeSyncRow[] {
  if (notCreated.length === 0) return []

  const globalReason = !policy.enabled
    ? CREATION_DISABLED_REASON
    : !policy.baseComplete
      ? INCOMPLETE_BASE_REASON
      : null
  if (globalReason) {
    return [
      {
        direction: "clockin→dimacon",
        name: `(${candidateLabel(notCreated.length)})`,
        status: "skipped",
        reason: globalReason,
      },
    ]
  }

  const rows: EmployeeSyncRow[] = notCreated
    .slice(0, MAX_SKIPPED_ROWS)
    .map(({ employee, reason }) => ({
      direction: "clockin→dimacon" as const,
      clockinId: employee.id,
      name: `${employee.firstName} ${employee.lastName}`.trim() || `#${employee.id}`,
      status: "skipped" as const,
      reason,
    }))
  const rest = notCreated.length - rows.length
  if (rest > 0) {
    rows.push({
      direction: "clockin→dimacon",
      name: `(${rest} weitere ${rest === 1 ? "Kandidat" : "Kandidaten"})`,
      status: "skipped",
      reason: `nicht angelegt — Ergebnis auf ${MAX_SKIPPED_ROWS} Einzelbegründungen begrenzt`,
    })
  }
  return rows
}

/** Grund → Anzahl, absteigend und gedeckelt — Eingabe für die Log-Zeile. */
function countByReason(
  notCreated: { employee: ClockinEmployeeInfo; reason: string }[],
): Record<string, number> {
  const counts = new Map<string, number>()
  for (const { reason } of notCreated) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LOGGED_REASONS),
  )
}

function candidateLabel(count: number): string {
  return `${count} ${count === 1 ? "Kandidat" : "Kandidaten"}`
}

interface ClockinEmployeeRow {
  id?: number
  first_name?: string
  last_name?: string
  personnel_number?: string
  email?: string | null
  phone_work?: string | null
  contract_ending?: string | null
  customFields?: { custom_field_id?: number; value?: string | null }[]
}

interface ClockinEmployeeLoad {
  employees: ClockinEmployeeInfo[]
  /** false ⇒ Vergleichsbasis unvollständig — der Lauf legt nichts an */
  complete: boolean
  reason?: string
  pages: number
}

/** Query-Typ der Mitarbeiter-Listen — beide Endpunkte teilen ihn. */
type EmployeeListQuery = NonNullable<Parameters<typeof clockin.getAListOfEmployees>[0]>["query"]

/** s. `clockinPageQuery` — der `page`-Cast liegt zentral in clockin-pages.ts. */
function pageQuery(page: number | undefined): EmployeeListQuery {
  return clockinPageQuery<NonNullable<EmployeeListQuery>>(page)
}

async function loadClockinEmployees(
  client: ClockInClient,
  log: Logger,
  withCustomFields: boolean,
): Promise<ClockinEmployeeLoad> {
  // Custom-Field-Werte gibt es nur über die Search-API (includes-Body) —
  // ohne Custom-Ziele reicht die einfache Liste.
  const fetchPage = (page: number | undefined) =>
    withRetry(() =>
      withCustomFields
        ? clockin.searchForEmployees({
            client,
            body: { includes: [{ relation: "customFields" }] },
            query: pageQuery(page),
          })
        : clockin.getAListOfEmployees({ client, query: pageQuery(page) }),
    ) as unknown as Promise<ClockinPage<ClockinEmployeeRow>>

  const loaded = await loadAllClockinPages<ClockinEmployeeRow>({
    fetchPage,
    idOf: (r) => r.id,
    log,
    label: "clockin employees",
  })

  return {
    employees: loaded.rows
      .filter((r): r is ClockinEmployeeRow & { id: number } => r.id !== undefined)
      .map((r) => ({
        id: r.id,
        firstName: r.first_name ?? "",
        lastName: r.last_name ?? "",
        personnelNumber: r.personnel_number || undefined,
        email: r.email ?? undefined,
        phoneWork: r.phone_work ?? undefined,
        contractEnding: r.contract_ending ?? undefined,
        raw: r as unknown as Record<string, unknown>,
        customFieldValues: r.customFields,
      })),
    complete: loaded.complete,
    reason: loaded.reason,
    pages: loaded.pages,
  }
}
