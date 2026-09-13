import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { createLimit, withRetry } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import type { Logger } from "../../lib/log.js"
import {
  BULK_FETCH_THRESHOLD,
  loadAllCustomers,
  loadAllProjects,
  loadAppointmentsInPeriod,
  loadCustomersById,
  loadJobBundles,
  loadJobsInPeriod,
  loadProjectsById,
  loadTeamAssignmentsInPeriod,
} from "../shared/dimacon.js"
import type {
  AppointmentForDate,
  DimaconCustomerInfo,
  DimaconEmployeeFull,
  DimaconJobBundle,
  DimaconProjectInfo,
  DimaconTeamAssignment,
} from "../shared/dimacon.js"
import { nextDay } from "../shared/time.js"

// `DimaconProjectInfo` lebt seit den Sammelabrufen in shared/dimacon.ts
// (getProjectById UND getAllProjects liefern dieselbe Form) — hier nur noch
// re-exportiert, damit die bestehenden Importpfade gültig bleiben.
export type { DimaconProjectInfo } from "../shared/dimacon.js"

export interface DimaconEmployeeInfo {
  id: string
  firstName: string
  lastName: string
  email?: string
}

/**
 * Welcher Weg tatsächlich genommen wurde. Jede Bündelung hat einen
 * Einzelabruf-Fallback — ohne diese Anzeige wäre im Ergebnis nicht
 * erkennbar, ob die Optimierung greift oder still auf den alten Pfad fällt.
 */
export interface EnrichSources {
  jobs: "period" | "per-job"
  teamAssignments: "period" | "per-job" | "none"
  projects: "bulk" | "per-id"
  customers: "preloaded" | "bulk" | "per-id"
}

/**
 * Planungshorizont für den Archiv-Schutz: alle Dimacon-Projekte, die im
 * Fenster um das Sync-Datum herum einen nicht-archivierten Termin haben.
 *
 * `complete: false` heißt „Horizont unbekannt" — die Archiv-Phase darf dann
 * NICHTS archivieren. Sie liest seit #15 alle Seiten des Clockin-Bestands;
 * auf halber Datenbasis wäre der Blast-Radius eines Fehlers der gesamte
 * Projektbestand.
 */
export interface HorizonPlan {
  projectIds: Set<string>
  complete: boolean
  reason?: string
}

export interface EnrichedDimaconData {
  jobs: Map<string, DimaconJobBundle>
  projects: Map<string, DimaconProjectInfo>
  customers: Map<string, DimaconCustomerInfo>
  employees: Map<string, DimaconEmployeeInfo>
  horizon: HorizonPlan
  sources: EnrichSources
}

export interface EnrichOptions {
  /** Aufträge des Sync-Datums (aus `loadAppointments`) */
  jobIds: string[]
  /** Live-Termine des Sync-Datums — liefern die teamId für den Join */
  appointments: readonly AppointmentForDate[]
  date: string
  /** false ⇒ `steps.assignments` ist aus, Team-Zuweisungen werden nicht geladen */
  needsTeamAssignments: boolean
  /**
   * Fenster des Archiv-Schutzes (`to` exklusiv). Fehlt es, läuft die
   * Archiv-Phase nicht und der Horizont wird gar nicht erst ermittelt.
   */
  horizon?: { from: string; to: string }
  /** Bereits geladener Dimacon-Kundenbestand (run.ts lädt ihn ohnehin) */
  customers?: readonly DimaconCustomerInfo[]
  /** Bereits geladene Dimacon-Mitarbeiter (Phase 1 lädt sie ohnehin) */
  employees?: readonly DimaconEmployeeFull[]
  log?: Logger
}

/**
 * Deckel für das Nachladen einzelner Aufträge des Horizonts. Greift nur,
 * wenn `getAllJobsInPeriod` die Aufträge des Fensters NICHT liefert (z. B.
 * weil der Endpunkt nach Fälligkeits- statt Termindatum filtert). Darüber
 * gilt der Horizont als unbekannt — lieber nicht archivieren als N Requests
 * zu feuern oder auf halber Datenbasis zu schreiben.
 */
const MAX_HORIZON_JOB_LOOKUPS = 200

/**
 * Lädt die Dimacon-Stammdaten zur Tagesplanung. Ab `BULK_FETCH_THRESHOLD`
 * Elementen laufen Sammelabrufe (ein Request) statt Einzelabrufen (ein
 * Request je Element); jeder Sammelabruf lädt fehlende Ids einzeln nach.
 */
export async function enrich(
  client: DimaconClient,
  options: EnrichOptions,
): Promise<EnrichedDimaconData> {
  const { jobIds, appointments, date, needsTeamAssignments, horizon, log } = options
  // Reine Dimacon-Reads ⇒ Parallelität dieses Systems (CONCURRENCY_DIMACON).
  const limit = createLimit("dimacon")

  const employeesPromise = loadEmployeeInfos(client, options.employees)

  // Ein Zeitraum-Abruf bedient zwei Zwecke: die Aufträge des Tages und die
  // jobId → projectId-Auflösung des Archiv-Horizonts.
  const window = horizon ?? { from: date, to: nextDay(date) }
  const useBulkJobs = jobIds.length >= BULK_FETCH_THRESHOLD || horizon !== undefined

  let periodJobs: { jobId: string; projectId: string; customerId: string }[] = []
  let periodFailure: string | undefined
  if (useBulkJobs) {
    try {
      periodJobs = await loadJobsInPeriod(client, window.from, window.to)
    } catch (err) {
      periodFailure = formatError(err)
      log?.warn("dimacon period job fetch failed — falling back to per-job lookups", {
        error: periodFailure,
      })
    }
  }

  const periodById = new Map(periodJobs.map((j) => [j.jobId, j]))
  const missingJobIds = jobIds.filter((id) => !periodById.has(id))
  const jobsSource: EnrichSources["jobs"] =
    useBulkJobs && missingJobIds.length < jobIds.length ? "period" : "per-job"

  // Team-Zuweisungen: aus dem Zeitraum-Abruf (ein Request) oder — wenn die
  // Probe abweicht bzw. zu wenige Aufträge anstehen — aus den Einzelabrufen.
  const assignments = await planTeamAssignments(client, limit, {
    jobIds,
    appointments,
    date,
    needsTeamAssignments,
    canBundle: jobsSource === "period",
    log,
  })

  // Genau EIN Einzelabruf-Durchgang: Aufträge, die der Zeitraum-Abruf nicht
  // kennt, plus — bei Einzelabruf-Modus der Zuweisungen — alle übrigen.
  const bundleById = new Map<string, DimaconJobBundle>()
  for (const bundle of assignments.probed) bundleById.set(bundle.jobId, bundle)
  const bundleIds = (assignments.source === "per-job" ? jobIds : missingJobIds).filter(
    (id) => !bundleById.has(id),
  )
  for (const bundle of bundleIds.length > 0 ? await loadJobBundles(client, bundleIds, limit) : []) {
    bundleById.set(bundle.jobId, bundle)
  }

  const jobs = new Map<string, DimaconJobBundle>()
  for (const jobId of jobIds) {
    const bundle = bundleById.get(jobId)
    const fromPeriod = periodById.get(jobId)
    const base = fromPeriod ?? bundle
    if (!base) continue
    jobs.set(jobId, {
      jobId,
      projectId: base.projectId,
      customerId: base.customerId,
      teamAssignments: !needsTeamAssignments
        ? []
        : assignments.source === "period"
          ? assignments.forJob(jobId)
          : (bundle?.teamAssignments ?? []),
    })
  }

  const projectIds = unique([...jobs.values()].map((j) => j.projectId))
  const customerIds = unique([...jobs.values()].map((j) => j.customerId))

  const [projects, customers, employees] = await Promise.all([
    loadProjects(client, projectIds, limit, log),
    loadCustomers(client, customerIds, options.customers, limit, log),
    employeesPromise,
  ])

  const horizonPlan = horizon
    ? await buildHorizon(client, limit, {
        window: horizon,
        periodById,
        periodFailure,
        knownJobs: jobs,
        log,
      })
    : { projectIds: new Set<string>(), complete: false, reason: "Archiv-Schritt deaktiviert" }

  const sources: EnrichSources = {
    jobs: jobsSource,
    teamAssignments: assignments.source,
    projects: projects.source,
    customers: customers.source,
  }
  log?.info("dimacon enrichment finished", {
    jobs: jobs.size,
    projects: projects.rows.size,
    customers: customers.rows.size,
    horizonProjects: horizonPlan.projectIds.size,
    horizonComplete: horizonPlan.complete,
    sources,
  })

  return {
    jobs,
    projects: projects.rows,
    customers: customers.rows,
    employees,
    horizon: horizonPlan,
    sources,
  }
}

type Limit = ReturnType<typeof createLimit>

interface TeamAssignmentPlan {
  forJob: (jobId: string) => DimaconTeamAssignment[]
  source: EnrichSources["teamAssignments"]
  /** Aufträge der Proben — werden oben wiederverwendet statt neu geladen. */
  probed: DimaconJobBundle[]
}

/**
 * Team-Zuweisungen des Tages. `TeamAssignmentTo` trägt keine jobId — der
 * Join läuft über (teamId, Datum) der Termine. Weil diese Äquivalenz zu
 * `getJobById().teamAssignments` nicht dokumentiert ist, wird sie je Lauf
 * gegen einen echten Auftrag geprobt — und, wenn dieser am Sync-Datum
 * niemanden eingeplant hat, gegen einen zweiten, für den der Join etwas
 * liefert. Weicht eine Probe ab oder lässt sich der Join gar nicht belegen,
 * fällt der ganze Lauf auf die Einzelabrufe zurück.
 */
async function planTeamAssignments(
  client: DimaconClient,
  limit: Limit,
  opts: {
    jobIds: string[]
    appointments: readonly AppointmentForDate[]
    date: string
    needsTeamAssignments: boolean
    canBundle: boolean
    log?: Logger
  },
): Promise<TeamAssignmentPlan> {
  const { jobIds, appointments, date, needsTeamAssignments, canBundle, log } = opts
  const perJob: TeamAssignmentPlan = { forJob: () => [], source: "per-job", probed: [] }

  if (!needsTeamAssignments || jobIds.length === 0) {
    return { forJob: () => [], source: "none", probed: [] }
  }

  // Unter der Schwelle bzw. ohne Zeitraum-Auflösung sind die Einzelabrufe
  // billiger als Zeitraum-Abruf + Probe.
  if (!canBundle || jobIds.length < BULK_FETCH_THRESHOLD) return perJob

  let periodAssignments: DimaconTeamAssignment[]
  try {
    periodAssignments = await loadTeamAssignmentsInPeriod(client, date, nextDay(date))
  } catch (err) {
    log?.warn("dimacon team assignment period fetch failed — falling back to per-job lookups", {
      error: formatError(err),
    })
    return perJob
  }

  const teamsByJob = new Map<string, Set<string>>()
  for (const a of appointments) {
    if (!a.date.startsWith(date)) continue
    const set = teamsByJob.get(a.jobId) ?? new Set<string>()
    set.add(a.teamId)
    teamsByJob.set(a.jobId, set)
  }

  const forDate = periodAssignments.filter((a) => a.date.startsWith(date))
  const joined = (jobId: string): DimaconTeamAssignment[] => {
    const teams = teamsByJob.get(jobId)
    if (!teams || teams.size === 0) return []
    return forDate.filter((a) => a.teamId !== undefined && a.teamId !== null && teams.has(a.teamId))
  }

  /** Liefert der Join für diesen Auftrag überhaupt etwas? (ohne Allokation) */
  const hasJoin = (jobId: string): boolean => {
    const teams = teamsByJob.get(jobId)
    if (!teams || teams.size === 0) return false
    return forDate.some((a) => a.teamId !== undefined && a.teamId !== null && teams.has(a.teamId))
  }

  // Geprobt wird IMMER zuerst gegen `jobIds[0]` — unvoreingenommen, und damit
  // die einzige Chance zu bemerken, dass der Join einen Auftrag ÜBERSIEHT
  // (das ist die Richtung, die in den Detach läuft). Bleibt dieser Vergleich
  // aussagelos, weil der Auftrag am Sync-Datum niemanden eingeplant hat, wird
  // ein zweiter Auftrag geprobt, den der Join selbst als Treffer ausweist.
  //
  // Ohne diese Rotation bestünde die Probe trivial: erwartete und gejointe
  // Menge sind beide leer, `sameSet` passt — ein Join, der GENERELL ins Leere
  // läuft (teamId null, abweichendes Datumsformat), sähe exakt genauso aus.
  // Der Blast-Radius wäre der gesamte Tagesbestand: `forJob()` gäbe überall []
  // zurück, und die Projekt-Phase liest das als „niemand eingeplant" und hängt
  // die komplette Belegschaft jedes Tagesprojekts ab (projects.ts, toRemove).
  //
  // NICHT abgedeckt (bewusst): Übersieht der Join nur EINZELNE Aufträge und
  // ist `jobIds[0]` zufällig ein Treffer, bleibt das unentdeckt — die
  // unvoreingenommene erste Probe ist die einzige Chance darauf. Und hat ein
  // Mandant real gar keine Team-Zuweisungen, detacht auch die Ground Truth.
  // Der Guard schützt vor dem UNBELEGTEN Bündelungs-Pfad, nicht vor dem
  // Detach an sich.
  const joinHitId = jobIds.find(hasJoin)
  const candidates =
    joinHitId === undefined || joinHitId === jobIds[0] ? [jobIds[0]] : [jobIds[0], joinHitId]

  const probed: DimaconJobBundle[] = []
  for (const jobId of candidates) {
    let bundle: DimaconJobBundle
    try {
      ;[bundle] = await loadJobBundles(client, [jobId], limit)
    } catch (err) {
      log?.warn("team assignment probe failed — falling back to per-job lookups", {
        error: formatError(err),
      })
      return { ...perJob, probed }
    }
    probed.push(bundle)

    const expected = employeeSet(bundle.teamAssignments.filter((a) => a.date.startsWith(date)))
    const actual = employeeSet(joined(jobId))
    if (!sameSet(expected, actual)) {
      log?.warn("team assignment join differs from getJobById — falling back to per-job lookups", {
        jobId,
        expected: expected.size,
        actual: actual.size,
      })
      return { ...perJob, probed }
    }
    // Gleich UND nicht leer ⇒ belegt. (Nach `sameSet` ist expected.size > 0
    // genau dann, wenn auch actual.size > 0 ist.)
    if (expected.size > 0) return { forJob: joined, source: "period", probed }
  }

  // Kein Kandidat konnte den Join belegen: er trifft keinen einzigen Auftrag,
  // und der geprobte Auftrag hat keine Zuordnung. Das kann legitim sein (an
  // diesem Tag ist niemand eingeplant) — nur belegen lässt es sich nicht, und
  // die teure Richtung des Irrtums ist der Massen-Detach. Der Fallback kostet
  // N `getJobById` und liefert dasselbe Ergebnis aus der autoritativen Quelle.
  log?.warn("team assignment join could not be verified — falling back to per-job lookups", {
    jobs: jobIds.length,
    periodRows: periodAssignments.length,
    rowsForDate: forDate.length,
  })
  return { ...perJob, probed }
}

async function loadProjects(
  client: DimaconClient,
  projectIds: string[],
  limit: Limit,
  log?: Logger,
): Promise<{ rows: Map<string, DimaconProjectInfo>; source: EnrichSources["projects"] }> {
  // Der Sammelabruf ist eine Optimierung, kein Muss — wie der Zeitraum-Abruf
  // der Aufträge und der Team-Zuweisungen oben. Ohne diesen Fallback riss ein
  // dauerhafter Fehler den GANZEN Lauf ab (`enrichment failed` in run.ts): es
  // gäbe weder Upserts noch Zuordnungen noch Archivierung.
  let all: DimaconProjectInfo[] | undefined
  if (projectIds.length >= BULK_FETCH_THRESHOLD) {
    try {
      all = await loadAllProjects(client)
    } catch (err) {
      log?.warn("dimacon project bulk fetch failed — falling back to per-id lookups", {
        error: formatError(err),
      })
    }
  }

  if (all === undefined) {
    // Höchstens ein Request je Projekt des Tages — dieselbe Größenordnung,
    // die der per-job-Fallback der Aufträge ohnehin feuert.
    const rows = await loadProjectsById(client, projectIds, limit)
    return { rows: new Map(rows.map((p) => [p.id, p])), source: "per-id" }
  }

  const byId = new Map(all.map((p) => [p.id, p]))
  const missing = projectIds.filter((id) => !byId.has(id))
  const extra = missing.length > 0 ? await loadProjectsById(client, missing, limit) : []
  const rows = new Map<string, DimaconProjectInfo>()
  for (const id of projectIds) {
    const row = byId.get(id)
    if (row) rows.set(id, row)
  }
  for (const row of extra) rows.set(row.id, row)
  return { rows, source: "bulk" }
}

async function loadCustomers(
  client: DimaconClient,
  customerIds: string[],
  preloaded: readonly DimaconCustomerInfo[] | undefined,
  limit: Limit,
  log?: Logger,
): Promise<{ rows: Map<string, DimaconCustomerInfo>; source: EnrichSources["customers"] }> {
  const collect = async (
    byId: Map<string, DimaconCustomerInfo>,
    source: EnrichSources["customers"],
  ) => {
    const missing = customerIds.filter((id) => !byId.has(id))
    const extra = missing.length > 0 ? await loadCustomersById(client, missing, limit) : []
    const rows = new Map<string, DimaconCustomerInfo>()
    for (const id of customerIds) {
      const row = byId.get(id)
      if (row) rows.set(id, row)
    }
    for (const row of extra) rows.set(row.id, row)
    return { rows, source }
  }

  // run.ts lädt den Gesamtbestand ohnehin (Namens-Fallback) — durchgereicht
  // kostet die Kunden-Auflösung damit KEINEN einzigen zusätzlichen Request.
  if (preloaded !== undefined) {
    return collect(new Map(preloaded.map((c) => [c.id, c])), "preloaded")
  }
  // Ohne vorgeladenen Bestand heißt das in der Praxis: `loadCustomerInventory`
  // (run.ts) ist fail-soft gescheitert. Der Sammelabruf hier ist damit ein
  // zweiter Versuch — ein transienter Fehler kann inzwischen weg sein.
  //
  // Dass der Lauf danach weiterläuft statt abzubrechen, hat einen Preis: für
  // die Kunden-Angleichung gilt `inventoryLoaded: false`, der Clockin-Namens-
  // Fallback ist damit aus (customers.ts) und es kann eher ein zusätzlicher
  // Clockin-Kunde entstehen. Genau diese Abwägung trifft `loadCustomerInventory`
  // bereits — ein sichtbarer Kunde zu viel ist besser als ein Lauf, der nichts
  // schreibt.
  let all: DimaconCustomerInfo[] | undefined
  if (customerIds.length >= BULK_FETCH_THRESHOLD) {
    try {
      all = await loadAllCustomers(client)
    } catch (err) {
      log?.warn("dimacon customer bulk fetch failed — falling back to per-id lookups", {
        error: formatError(err),
      })
    }
  }

  if (all === undefined) {
    const rows = await loadCustomersById(client, customerIds, limit)
    return { rows: new Map(rows.map((c) => [c.id, c])), source: "per-id" }
  }
  return collect(new Map(all.map((c) => [c.id, c])), "bulk")
}

/**
 * Projekte mit nicht-archiviertem Termin im Horizont-Fenster. Die Termine
 * kommen aus demselben Endpunkt wie die Tagesplanung (verifiziert im
 * Einsatz); die Zuordnung Termin → Projekt aus dem Zeitraum-Abruf der
 * Aufträge. Aufträge, die dort fehlen, werden einzeln nachgeladen — über
 * `MAX_HORIZON_JOB_LOOKUPS` gilt der Horizont als unbekannt.
 */
async function buildHorizon(
  client: DimaconClient,
  limit: Limit,
  opts: {
    window: { from: string; to: string }
    periodById: Map<string, { jobId: string; projectId: string; customerId: string }>
    periodFailure?: string
    knownJobs: Map<string, DimaconJobBundle>
    log?: Logger
  },
): Promise<HorizonPlan> {
  const { window, periodById, periodFailure, knownJobs, log } = opts

  let appointments: AppointmentForDate[]
  try {
    appointments = await loadAppointmentsInPeriod(client, window.from, window.to)
  } catch (err) {
    const reason = `Termine des Planungshorizonts konnten nicht geladen werden: ${formatError(err)}`
    log?.warn("horizon appointment fetch failed — archive phase will not write", { reason })
    return { projectIds: new Set(), complete: false, reason }
  }

  const jobIds = unique(appointments.filter((a) => !a.isArchived).map((a) => a.jobId))
  const projectIds = new Set<string>()
  const unresolved: string[] = []
  for (const jobId of jobIds) {
    const projectId = periodById.get(jobId)?.projectId ?? knownJobs.get(jobId)?.projectId
    if (projectId) projectIds.add(projectId)
    else unresolved.push(jobId)
  }

  if (unresolved.length > MAX_HORIZON_JOB_LOOKUPS) {
    const reason = `${unresolved.length} Aufträge des Planungshorizonts sind über den Zeitraum-Abruf nicht auflösbar${
      periodFailure ? ` (${periodFailure})` : ""
    } — mehr als das Limit von ${MAX_HORIZON_JOB_LOOKUPS} Einzelabrufen`
    log?.warn("horizon incomplete — archive phase will not write", { reason })
    return { projectIds, complete: false, reason }
  }

  if (unresolved.length > 0) {
    try {
      for (const bundle of await loadJobBundles(client, unresolved, limit)) {
        projectIds.add(bundle.projectId)
      }
    } catch (err) {
      const reason = `Aufträge des Planungshorizonts konnten nicht aufgelöst werden: ${formatError(err)}`
      log?.warn("horizon incomplete — archive phase will not write", { reason })
      return { projectIds, complete: false, reason }
    }
  }

  return { projectIds, complete: true }
}

async function loadEmployeeInfos(
  client: DimaconClient,
  preloaded: readonly DimaconEmployeeFull[] | undefined,
): Promise<Map<string, DimaconEmployeeInfo>> {
  if (preloaded !== undefined) {
    return new Map(
      preloaded.map((e) => [
        e.id,
        { id: e.id, firstName: e.firstName, lastName: e.lastName, email: e.email },
      ]),
    )
  }

  const [employees, users] = await Promise.all([
    withRetry(() => dimacon.getAllEmployees({ client })).then(
      (rows) => rows as unknown as { id: string; firstName: string; lastName: string }[],
    ),
    withRetry(() => dimacon.getAllUsers({ client })).then(
      (rows) => rows as unknown as { employeeId: string; emailAddress: string }[],
    ),
  ])

  const emailByEmployeeId = new Map(users.map((u) => [u.employeeId, u.emailAddress]))
  return new Map(
    employees.map((e) => [
      e.id,
      {
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        email: emailByEmployeeId.get(e.id),
      },
    ]),
  )
}

function employeeSet(assignments: readonly DimaconTeamAssignment[]): Set<string> {
  return new Set(assignments.map((a) => a.employeeId))
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}
