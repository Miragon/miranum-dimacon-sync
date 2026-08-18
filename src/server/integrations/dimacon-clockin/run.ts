import { getClockInClient, getDimaconClient } from "../../lib/clients.js"
import { createLimit } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import { log as rootLog } from "../../lib/log.js"
import { loadAppointments } from "../shared/dimacon.js"
import { FIELD_CATALOG } from "../shared/field-catalog.js"
import { EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import { loadMappingContext } from "../shared/mapping-context.js"
import type { EntityMappingContext, MappingContext } from "../shared/mapping-context.js"
import { todayInBerlin } from "../shared/time.js"
import { archiveUnplanned } from "./archive.js"
import { CustomerSyncer } from "./customers.js"
import { runEmployeeSync } from "./employee-sync/run-employee-sync.js"
import { EmployeeMatcher } from "./employees.js"
import { enrich } from "./enrichment.js"
import { ProjectUpserter } from "./projects.js"
import { DEFAULT_STEPS } from "./types.js"
import type { ProjectSyncResult, SyncError, SyncResult, SyncRunInput, SyncSteps } from "./types.js"

export async function runDimaconClockinSync(input: SyncRunInput): Promise<SyncResult> {
  const startedAt = Date.now()
  const date = input.date ?? todayInBerlin()
  const dryRun = input.dryRun ?? false
  let steps = input.steps ?? DEFAULT_STEPS
  const log = rootLog.child({ syncRun: { integration: "dimacon-clockin", date, dryRun, steps } })

  log.info("sync started")

  const errors: SyncError[] = []
  const projects: ProjectSyncResult[] = []
  const syncedClockinIds = new Set<number>()

  const clockinClient = getClockInClient()
  const dimaconClient = getDimaconClient()

  // Feld-Zuordnung laden — ohne persistierte Regeln macht das keine API-Calls
  // und entspricht exakt dem bisherigen Verhalten.
  let mappingContext: MappingContext
  try {
    mappingContext = await loadMappingContext(
      dimaconClient,
      () => clockinClient,
      "dimacon-clockin",
      ["project", "customer", "employee"],
    )
  } catch (err) {
    const message = formatError(err)
    // Safe-Mode: mit unklarer Zuordnung nichts schreiben — Auflösung,
    // Mitarbeiter-Zuordnung und Archiv-Schutz laufen normal weiter.
    log.error("failed to load field mapping — disabling write steps for this run", {
      error: message,
    })
    errors.push({
      scope: "mapping",
      message: `Feld-Zuordnung konnte nicht geladen werden — Schreibschritte (Mitarbeiter/Kunden/Projekte) für diesen Lauf deaktiviert (${message})`,
    })
    steps = { ...steps, employees: false, projects: false, customers: false }
    mappingContext = new Map()
  }
  const projectMapping = mappingContext.get("project") ?? defaultContext("project")
  const customerMapping_ = mappingContext.get("customer") ?? defaultContext("customer")
  const employeeMapping = mappingContext.get("employee") ?? defaultContext("employee")
  const onMappingWarning = (message: string) => {
    log.warn("field mapping warning", { message })
    errors.push({ scope: "mapping", message })
  }

  // Phase 1: Mitarbeiter-Stammdaten-Abgleich — vor der Tagesplanung, damit
  // frisch angelegte Clockin-Mitarbeiter sofort zuordenbar sind. Läuft auch
  // an Tagen ohne Termine (nicht datumsgebunden).
  let employeeSync: SyncResult["employeeSync"]
  let employeePairs: ReadonlyMap<string, number> = new Map()
  if (steps.employees) {
    const outcome = await runEmployeeSync(
      dimaconClient,
      clockinClient,
      employeeMapping,
      dryRun,
      log,
      onMappingWarning,
    )
    employeeSync = { counts: outcome.counts, rows: outcome.rows }
    employeePairs = outcome.pairs
    errors.push(...outcome.errors)
    log.info("employee sync finished", { ...outcome.counts, rows: outcome.rows.length })
  } else {
    log.info("employee sync step disabled — skipping")
  }

  // Phase 2: Tagesplanung
  let loaded
  try {
    loaded = await loadAppointments(dimaconClient, date)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load appointments", { error: message })
    errors.push({ scope: "appointments", message })
    return result(
      date,
      dryRun,
      steps,
      startedAt,
      { total: 0, live: 0 },
      employeeSync,
      projects,
      [],
      errors,
    )
  }

  log.info("appointments loaded", {
    appointmentsTotal: loaded.counts.total,
    appointmentsLive: loaded.counts.live,
    jobs: loaded.jobIds.length,
  })

  if (loaded.jobIds.length === 0) {
    log.info("no appointments for date — skipping daily plan")
    return result(date, dryRun, steps, startedAt, loaded.counts, employeeSync, projects, [], errors)
  }

  let enriched
  try {
    enriched = await enrich(dimaconClient, loaded.jobIds)
  } catch (err) {
    const message = formatError(err)
    log.error("enrichment failed", { error: message })
    errors.push({ scope: "enrichment", message })
    return result(date, dryRun, steps, startedAt, loaded.counts, employeeSync, projects, [], errors)
  }

  const employeeMatcher = new EmployeeMatcher(clockinClient, log, employeePairs)
  const customerSyncer = new CustomerSyncer(
    clockinClient,
    log,
    dryRun,
    steps.customers,
    customerMapping_,
    onMappingWarning,
  )
  const upserter = new ProjectUpserter(
    clockinClient,
    log,
    dryRun,
    steps,
    projectMapping,
    onMappingWarning,
    // Archiv-Schutz unabhängig vom Zeilen-Status: jede aufgelöste oder
    // angelegte Clockin-ID zählt als "heute eingeplant".
    (clockinProjectId) => syncedClockinIds.add(clockinProjectId),
  )

  const limit = createLimit()

  const projectTasks = [...enriched.jobs.values()].map((job) =>
    limit(async () => {
      const project = enriched.projects.get(job.projectId)
      if (!project) {
        const r: ProjectSyncResult = {
          dimaconProjectId: job.projectId,
          name: "(unknown)",
          status: "skipped",
          reason: "Projekt in Dimacon nicht gefunden",
        }
        projects.push(r)
        return
      }

      const dimaconCustomer = enriched.customers.get(job.customerId)
      if (!dimaconCustomer) {
        projects.push({
          dimaconProjectId: project.id,
          name: project.name,
          status: "skipped",
          reason: "Kunde in Dimacon nicht gefunden",
        })
        return
      }

      let customerMapping: Awaited<ReturnType<typeof customerSyncer.resolve>> = null
      try {
        customerMapping = await customerSyncer.resolve(dimaconCustomer)
      } catch (err) {
        const message = formatError(err)
        log.error("customer sync failed", { dimaconCustomerId: dimaconCustomer.id, error: message })
        errors.push({ scope: "customer", refId: dimaconCustomer.id, message })
        // NICHT abbrechen: der Upsert muss die Clockin-ID trotzdem auflösen,
        // sonst archiviert die Archiv-Phase ein heute eingeplantes Projekt.
      }

      const desiredEmployeeIds: number[] = []
      const dimaconEmployeeIds = steps.assignments
        ? unique(
            job.teamAssignments.filter((a) => a.date.startsWith(date)).map((a) => a.employeeId),
          )
        : []

      for (const employeeId of dimaconEmployeeIds) {
        const employee = enriched.employees.get(employeeId)
        if (!employee) {
          errors.push({
            scope: "employee",
            refId: employeeId,
            message: "employee not in dimacon employee list",
          })
          continue
        }
        try {
          const mapping = await employeeMatcher.match(employee)
          if (mapping) desiredEmployeeIds.push(mapping.clockinId)
          else
            errors.push({
              scope: "employee",
              refId: employeeId,
              message: `employee ${employee.firstName} ${employee.lastName} not matched in clockin`,
            })
        } catch (err) {
          const message = formatError(err)
          errors.push({ scope: "employee", refId: employeeId, message })
        }
      }

      try {
        const result = await upserter.upsert({
          date,
          project,
          customer: customerMapping,
          desiredEmployeeIds,
        })
        projects.push(result)
        // Auch failed-Zeilen mit bekannter ID sind eingeplant — nie archivieren.
        if (result.clockinProjectId !== undefined) {
          syncedClockinIds.add(result.clockinProjectId)
        }
      } catch (err) {
        const message = formatError(err)
        log.error("project upsert failed", { dimaconProjectId: project.id, error: message })
        errors.push({ scope: "project", refId: project.id, message })
        projects.push({
          dimaconProjectId: project.id,
          name: project.name,
          status: "failed",
          reason: message,
        })
      }
    }),
  )

  await Promise.all(projectTasks)

  let archived: Awaited<ReturnType<typeof archiveUnplanned>> = []
  if (steps.archive) {
    try {
      archived = await archiveUnplanned(clockinClient, syncedClockinIds, log, dryRun)
    } catch (err) {
      const message = formatError(err)
      log.error("archive phase failed", { error: message })
      errors.push({ scope: "archive", message })
    }
  } else {
    log.info("archive step disabled — skipping")
  }

  const final = result(
    date,
    dryRun,
    steps,
    startedAt,
    loaded.counts,
    employeeSync,
    projects,
    archived,
    errors,
  )
  log.info("sync finished", {
    durationMs: final.durationMs,
    employeeRows: final.employeeSync?.rows.length ?? 0,
    projects: final.projects.length,
    archived: final.archived.length,
    errors: final.errors.length,
  })
  return final
}

function result(
  date: string,
  dryRun: boolean,
  steps: SyncSteps,
  startedAt: number,
  appointments: SyncResult["appointments"],
  employeeSync: SyncResult["employeeSync"],
  projects: ProjectSyncResult[],
  archived: SyncResult["archived"],
  errors: SyncError[],
): SyncResult {
  return {
    date,
    dryRun,
    steps,
    durationMs: Date.now() - startedAt,
    appointments,
    employeeSync,
    projects,
    archived,
    errors,
  }
}

function defaultContext(entity: "project" | "customer" | "employee"): EntityMappingContext {
  return {
    entity,
    rules: FIELD_CATALOG[entity].defaultRules,
    catalog: FIELD_CATALOG[entity],
    discovery: EMPTY_DISCOVERY,
    isCustomized: false,
    hasCustomTargets: false,
  }
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}
