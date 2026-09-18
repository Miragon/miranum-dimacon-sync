import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { createLimit } from "../../lib/concurrency.js"
import { formatError } from "../../lib/errors.js"
import type { Logger } from "../../lib/log.js"
import { withPhase } from "../../lib/metrics.js"
import type { IntegrationRunContext } from "../types.js"
import { loadAllCustomers, loadAppointments, loadEmployeesWithEmail } from "../shared/dimacon.js"
import type { DimaconCustomerInfo, DimaconEmployeeFull } from "../shared/dimacon.js"
import { FIELD_CATALOG } from "../shared/field-catalog.js"
import { EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import { loadMappingContext } from "../shared/mapping-context.js"
import type { EntityMappingContext, MappingContext } from "../shared/mapping-context.js"
import { duplicateKeys, normalizeName } from "../shared/matching.js"
import { addDays, todayInBerlin } from "../shared/time.js"
import { archiveHorizonDays, archiveUnplanned } from "./archive.js"
import { loadClockinCustomerIndex } from "./customer-index.js"
import type { ClockinCustomerIndex } from "./customer-index.js"
import { CustomerSyncer } from "./customers.js"
import type { CustomerMatchingContext } from "./customers.js"
import { runEmployeeSync } from "./employee-sync/run-employee-sync.js"
import type { EmployeeSyncOutcome } from "./employee-sync/run-employee-sync.js"
import { EmployeeMatcher } from "./employees.js"
import { enrich } from "./enrichment.js"
import { loadClockinProjectsByNumber } from "./project-lookup.js"
import type { ClockinProjectLookup } from "./project-lookup.js"
import { ProjectUpserter } from "./projects.js"
import { DEFAULT_STEPS } from "./types.js"
import type {
  ProjectSyncResult,
  SyncError,
  SyncLookupInfo,
  SyncResult,
  SyncRunInput,
  SyncSteps,
} from "./types.js"

export async function runDimaconClockinSync(
  ctx: IntegrationRunContext,
  input: SyncRunInput,
): Promise<SyncResult> {
  const startedAt = Date.now()
  const date = input.date ?? todayInBerlin()
  const dryRun = input.dryRun ?? false
  let steps = input.steps ?? DEFAULT_STEPS
  const log = ctx.log.child({ syncRun: { integration: "dimacon-clockin", date, dryRun, steps } })

  log.info("sync started")

  const errors: SyncError[] = []
  const projects: ProjectSyncResult[] = []
  const syncedClockinIds = new Set<number>()

  // Beide Systeme sind requiredCredentials — eager auflösen ist korrekt.
  const clockinClient = await ctx.clients.clockin()
  const dimaconClient = await ctx.clients.dimacon()

  // Feld-Zuordnung laden — ohne persistierte Regeln macht das keine API-Calls
  // und entspricht exakt dem bisherigen Verhalten.
  let mappingContext: MappingContext
  try {
    mappingContext = await withPhase("mapping", () =>
      loadMappingContext({
        dimaconClient,
        getClockinClient: () => clockinClient,
        entities: ["project", "customer", "employee"],
        getFieldMapping: ctx.getFieldMapping,
      }),
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
    steps = {
      ...steps,
      employees: false,
      employeeCreateInDimacon: false,
      projects: false,
      customers: false,
    }
    mappingContext = new Map()
  }
  const projectMapping = mappingContext.get("project") ?? defaultContext("project")
  const customerMapping_ = mappingContext.get("customer") ?? defaultContext("customer")
  const employeeMapping = mappingContext.get("employee") ?? defaultContext("employee")
  const onMappingWarning = (message: string) => {
    log.warn("field mapping warning", { message })
    errors.push({ scope: "mapping", message })
  }

  // Dimacon-Mitarbeiter EINMAL für beide Phasen (Stammdaten-Abgleich und
  // Tagesplanung brauchen dieselbe Liste). Ein Ladefehler ist hier kein
  // Abbruch: beide Phasen laufen dann wie bisher mit ihrem eigenen Abruf
  // und melden den Fehler in ihrem eigenen Kontext.
  const dimaconEmployeesPromise: Promise<DimaconEmployeeFull[] | undefined> = withPhase(
    "dimacon-employees",
    () => loadEmployeesWithEmail(dimaconClient),
  ).catch((err: unknown) => {
    log.warn("failed to preload dimacon employees — phases fall back to their own fetch", {
      error: formatError(err),
    })
    return undefined
  })

  // Phase 1: Mitarbeiter-Stammdaten-Abgleich. Läuft ab hier NEBEN der
  // Tagesplanung — er ist nicht datumsgebunden und die Dimacon-Reads der
  // Tagesplanung hängen nicht von ihm ab. Erst das Mitarbeiter-MATCHING
  // braucht sein Ergebnis (`employeePairs`).
  //
  // `.catch()` hängt sofort dran: ohne das wäre jeder frühe Rückgabepfad
  // eine unhandled rejection.
  let employeeSync: SyncResult["employeeSync"]
  let employeePairs: ReadonlyMap<string, number> = new Map()
  let employeeSettled = false
  const employeeSyncPromise: Promise<EmployeeSyncOutcome | undefined> = steps.employees
    ? dimaconEmployeesPromise
        .then((preloaded) =>
          withPhase("employee-sync", () =>
            runEmployeeSync(
              dimaconClient,
              clockinClient,
              employeeMapping,
              { dryRun, createInDimacon: steps.employeeCreateInDimacon },
              log,
              onMappingWarning,
              preloaded,
            ),
          ),
        )
        .catch((err: unknown) => {
          const message = formatError(err)
          log.error("employee sync failed", { error: message })
          errors.push({ scope: "employee", message })
          return undefined
        })
    : Promise.resolve(undefined)
  if (!steps.employees) log.info("employee sync step disabled — skipping")

  /**
   * Ergebnis des Stammdaten-Abgleichs einsammeln. MUSS auf JEDEM
   * Rückgabepfad laufen — sonst geht das Ergebnis der parallelen Phase
   * verloren und der Lauf endet, während sie noch schreibt.
   */
  const settleEmployeeSync = async (): Promise<void> => {
    if (employeeSettled) return
    employeeSettled = true
    const outcome = await employeeSyncPromise
    if (!outcome) return
    employeeSync = { counts: outcome.counts, rows: outcome.rows }
    employeePairs = outcome.pairs
    errors.push(...outcome.errors)
    log.info("employee sync finished", { ...outcome.counts, rows: outcome.rows.length })
  }

  // Phase 2: Tagesplanung
  let loaded
  try {
    loaded = await withPhase("appointments", () => loadAppointments(dimaconClient, date))
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load appointments", { error: message })
    errors.push({ scope: "appointments", message })
    await settleEmployeeSync()
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
    await settleEmployeeSync()
    return result(date, dryRun, steps, startedAt, loaded.counts, employeeSync, projects, [], errors)
  }

  // Gesamtbestand der Dimacon-Kunden: sichert den Namens-Fallback ab UND
  // ersetzt die Einzelabrufe der Kunden im Enrichment (ein Aufruf statt C).
  // Der Tagesausschnitt taugt für den Fallback NICHT: der gleichnamige
  // Zwilling hat meist gerade keinen Termin, wäre im Ausschnitt unsichtbar
  // und der Fallback verknüpfte den Kunden dauerhaft mit dem Clockin-Kunden
  // des Zwillings.
  const inventory = await withPhase("customer-inventory", () =>
    loadCustomerInventory(dimaconClient, log, errors),
  )

  // Archiv-Horizont: ±N Tage um das Sync-Datum. Was in diesem Fenster
  // eingeplant ist, wird nicht archiviert — sonst pendeln wiederkehrende
  // Projekte täglich zwischen archiviert und aktiv.
  //
  // LOAD-BEARING: Das Fenster spannt IMMER auch über heute. `date` ist frei
  // wählbar (Run-Formular, Webhook) — hinge der Horizont allein daran, würde
  // ein Live-Lauf für ein vergangenes Datum den kompletten aktuell
  // eingeplanten Bestand archivieren, weil dessen Termine außerhalb des
  // Fensters lägen.
  const horizonDays = archiveHorizonDays()
  const today = todayInBerlin()
  const horizonFrom = date < today ? date : today
  const horizonTo = date > today ? date : today
  const horizon = steps.archive
    ? { from: addDays(horizonFrom, -horizonDays), to: addDays(horizonTo, horizonDays + 1) }
    : undefined

  let enriched
  try {
    const preloadedEmployees = await dimaconEmployeesPromise
    enriched = await withPhase("enrich", () =>
      enrich(dimaconClient, {
        jobIds: loaded.jobIds,
        appointments: loaded.appointments,
        date,
        needsTeamAssignments: steps.assignments,
        horizon,
        customers: inventory.customers,
        employees: preloadedEmployees,
        log,
      }),
    )
  } catch (err) {
    const message = formatError(err)
    log.error("enrichment failed", { error: message })
    errors.push({ scope: "enrichment", message })
    await settleEmployeeSync()
    return result(date, dryRun, steps, startedAt, loaded.counts, employeeSync, projects, [], errors)
  }

  // Clockin-Vorabladungen. Beide sind reine Optimierungen: schlägt eine
  // fehl, laufen die Einzelsuchen weiter — nur langsamer.
  const onPrefetchFailure = (what: string) => (err: unknown) => {
    const message = formatError(err)
    log.warn("clockin prefetch failed — falling back to per-item lookups", {
      what,
      error: message,
    })
    errors.push({
      scope: "load",
      message: `${what} konnte nicht vorab geladen werden — Einzelabrufe für diesen Lauf (${message})`,
    })
    return undefined
  }

  const dimaconProjectIds = unique([...enriched.jobs.values()].map((j) => j.projectId))
  const neededCustomers = unique([...enriched.jobs.values()].map((j) => j.customerId)).length

  const [customerIndex, projectLookup]: [
    ClockinCustomerIndex | undefined,
    ClockinProjectLookup | undefined,
  ] = await Promise.all([
    withPhase("customer-index", () =>
      loadClockinCustomerIndex(clockinClient, { neededCustomers, log }),
    ).catch(onPrefetchFailure("Clockin-Kundenbestand")),
    withPhase("project-lookup", () =>
      loadClockinProjectsByNumber(clockinClient, dimaconProjectIds, {
        withCustomFields: projectMapping.hasCustomTargets,
        withEmployees: steps.assignments,
        log,
      }),
    ).catch(onPrefetchFailure("Clockin-Projekte")),
  ])

  const onCustomerReport = (message: string) => {
    errors.push({ scope: "customer", message })
  }

  // Erst hier wird das Ergebnis von Phase 1 gebraucht — das Matching seedet
  // sich aus den Paaren des Stammdaten-Abgleichs.
  await settleEmployeeSync()

  const employeeMatcher = new EmployeeMatcher(clockinClient, log, employeePairs)
  const customerSyncer = new CustomerSyncer(
    clockinClient,
    log,
    dryRun,
    steps.customers,
    customerMapping_,
    onMappingWarning,
    inventory.matching,
    onCustomerReport,
    customerIndex,
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
    projectLookup,
  )

  // Die Projekt-Tasks schreiben nach Clockin (Dimacon ist zu diesem
  // Zeitpunkt bereits geladen) — maßgeblich ist deshalb Clockin.
  const limit = createLimit("clockin")

  // Die Tasks werden INNERHALB der Phase erzeugt: AsyncLocalStorage bindet
  // den Kontext beim Anlegen des Callbacks — außerhalb erzeugte Tasks
  // liefen an der Phasen-Zuordnung vorbei.
  await withPhase("projects", () => {
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
          log.error("customer sync failed", {
            dimaconCustomerId: dimaconCustomer.id,
            error: message,
          })
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
            else {
              const name = `${employee.firstName} ${employee.lastName}`
              const personnelNumber = employee.personnelNumber?.trim()
              errors.push({
                scope: "employee",
                refId: employeeId,
                message: personnelNumber
                  ? `Mitarbeiter ${name} (PNr ${personnelNumber}) in Clockin nicht eindeutig gefunden — nicht dem Projekt zugeordnet`
                  : `Mitarbeiter ${name} hat in Dimacon keine Personalnummer — nicht dem Projekt zugeordnet`,
              })
            }
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

    return Promise.all(projectTasks)
  })

  let archived: Awaited<ReturnType<typeof archiveUnplanned>> = []
  if (steps.archive) {
    if (!enriched.horizon.complete) {
      errors.push({
        scope: "archive",
        message: `Archiv-Phase übersprungen: Planungshorizont (±${horizonDays} Tage) konnte nicht ermittelt werden${
          enriched.horizon.reason ? ` — ${enriched.horizon.reason}` : ""
        }`,
      })
    }
    try {
      archived = await withPhase("archive", () =>
        archiveUnplanned(
          clockinClient,
          {
            syncedClockinProjectIds: syncedClockinIds,
            horizonProjectNumbers: new Set(
              [...enriched.horizon.projectIds].map((id) => normalizeName(id)),
            ),
            horizonComplete: enriched.horizon.complete,
            dryRun,
            onSkipped: (message) => errors.push({ scope: "archive", message }),
            onError: (clockinProjectId, message) =>
              errors.push({
                scope: "archive",
                refId: String(clockinProjectId),
                message: `Projekt ${clockinProjectId} konnte nicht archiviert werden: ${message}`,
              }),
          },
          log,
        ),
      )
    } catch (err) {
      const message = formatError(err)
      log.error("archive phase failed", { error: message })
      errors.push({ scope: "archive", message })
    }
  } else {
    log.info("archive step disabled — skipping")
  }

  const lookups: SyncLookupInfo = {
    ...enriched.sources,
    clockinCustomerIndex: customerIndex !== undefined,
    clockinProjectPrefetch:
      projectLookup === undefined ? "off" : projectLookup.bundled ? "bundled" : "per-id",
    archiveHorizonDays: horizonDays,
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
    lookups,
  )
  log.info("sync finished", {
    durationMs: final.durationMs,
    employeeRows: final.employeeSync?.rows.length ?? 0,
    projects: final.projects.length,
    archived: final.archived.length,
    errors: final.errors.length,
    lookups,
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
  lookups?: SyncLookupInfo,
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
    ...(lookups ? { lookups } : {}),
  }
}

interface CustomerInventory {
  matching: CustomerMatchingContext
  /** undefined = Bestand nicht geladen; das Enrichment lädt dann einzeln nach */
  customers?: DimaconCustomerInfo[]
}

/**
 * Lädt den Dimacon-Kundenbestand und leitet daraus die Absicherung des
 * Namens-Fallbacks ab. Fail-closed bei Ladefehler: ohne Gesamtbestand ist der
 * Fallback nicht absicherbar und entfällt (`inventoryLoaded: false`) — der
 * Lauf legt dann eher einen sichtbaren Clockin-Kunden zu viel an, als still
 * auf den falschen zu buchen.
 */
async function loadCustomerInventory(
  dimaconClient: DimaconClient,
  log: Logger,
  errors: SyncError[],
): Promise<CustomerInventory> {
  try {
    const all = await loadAllCustomers(dimaconClient)
    const knownCustomerNumbers = new Set(
      all.map((c) => normalizeName(c.customerNumber)).filter((n) => n !== ""),
    )
    const duplicateNames = duplicateKeys(all, (c) => c.name)
    log.info("dimacon customer inventory loaded", {
      customers: all.length,
      duplicateNames: duplicateNames.size,
    })
    return {
      matching: { duplicateNames, knownCustomerNumbers, inventoryLoaded: true },
      customers: all,
    }
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load dimacon customer inventory — name fallback disabled", {
      error: message,
    })
    errors.push({
      scope: "customer",
      message: `Dimacon-Kundenbestand konnte nicht geladen werden — Namens-Fallback für diesen Lauf deaktiviert (${message})`,
    })
    return {
      matching: {
        duplicateNames: new Set(),
        knownCustomerNumbers: new Set(),
        inventoryLoaded: false,
      },
    }
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
