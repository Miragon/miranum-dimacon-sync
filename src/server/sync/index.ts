import { getClockInClient, getDimaconClient, getLexofficeClient } from "../lib/clients.js"
import { createLimit } from "../lib/concurrency.js"
import { formatError } from "../lib/errors.js"
import { log as rootLog } from "../lib/log.js"
import { loadAppointments } from "./appointments.js"
import { archiveUnplanned } from "./archive.js"
import { CustomerSyncer } from "./customers.js"
import { EmployeeMatcher } from "./employees.js"
import { enrich } from "./enrichment.js"
import { runExclusive } from "./mutex.js"
import { ProjectUpserter } from "./projects.js"
import type { ProjectSyncResult, SyncError, SyncResult, SyncRunInput } from "./types.js"

export async function runSync(input: SyncRunInput): Promise<SyncResult> {
  return runExclusive(() => doRun(input))
}

function todayInBerlin(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date())
}

async function doRun(input: SyncRunInput): Promise<SyncResult> {
  const startedAt = Date.now()
  const date = input.date ?? todayInBerlin()
  const dryRun = input.dryRun ?? false
  const log = rootLog.child({ syncRun: { date, dryRun } })

  log.info("sync started")

  const errors: SyncError[] = []
  const projects: ProjectSyncResult[] = []
  const syncedClockinIds = new Set<number>()

  const clockinClient = getClockInClient()
  const dimaconClient = getDimaconClient()
  const lexofficeClient = getLexofficeClient()

  let loaded
  try {
    loaded = await loadAppointments(dimaconClient, date)
  } catch (err) {
    const message = formatError(err)
    log.error("failed to load appointments", { error: message })
    errors.push({ scope: "appointments", message })
    return result(date, dryRun, startedAt, projects, [], errors)
  }

  log.info("appointments loaded", {
    appointments: loaded.appointments.length,
    jobs: loaded.jobIds.length,
  })

  if (loaded.jobIds.length === 0) {
    log.info("no appointments for date — nothing to sync")
    return result(date, dryRun, startedAt, projects, [], errors)
  }

  let enriched
  try {
    enriched = await enrich(dimaconClient, loaded.jobIds)
  } catch (err) {
    const message = formatError(err)
    log.error("enrichment failed", { error: message })
    errors.push({ scope: "enrichment", message })
    return result(date, dryRun, startedAt, projects, [], errors)
  }

  const employeeMatcher = new EmployeeMatcher(clockinClient, log)
  const customerSyncer = new CustomerSyncer(
    clockinClient,
    dimaconClient,
    lexofficeClient,
    log,
    dryRun,
  )
  const upserter = new ProjectUpserter(clockinClient, log, dryRun)

  const limit = createLimit()

  const projectTasks = [...enriched.jobs.values()].map((job) =>
    limit(async () => {
      const project = enriched.projects.get(job.projectId)
      if (!project) {
        const r: ProjectSyncResult = {
          dimaconProjectId: job.projectId,
          name: "(unknown)",
          status: "skipped",
          reason: "project not found in dimacon",
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
          reason: "customer not found in dimacon",
        })
        return
      }

      let customerMapping
      try {
        customerMapping = await customerSyncer.resolve(dimaconCustomer)
      } catch (err) {
        const message = formatError(err)
        log.error("customer sync failed", { dimaconCustomerId: dimaconCustomer.id, error: message })
        errors.push({ scope: "customer", refId: dimaconCustomer.id, message })
        projects.push({
          dimaconProjectId: project.id,
          name: project.name,
          status: "skipped",
          reason: `customer sync failed: ${message}`,
        })
        return
      }

      const desiredEmployeeIds: number[] = []
      const dimaconEmployeeIds = unique(
        job.teamAssignments.filter((a) => a.date.startsWith(date)).map((a) => a.employeeId),
      )

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
        if (result.clockinProjectId !== undefined && result.status !== "failed") {
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
  try {
    archived = await archiveUnplanned(clockinClient, syncedClockinIds, log, dryRun)
  } catch (err) {
    const message = formatError(err)
    log.error("archive phase failed", { error: message })
    errors.push({ scope: "archive", message })
  }

  const final = result(date, dryRun, startedAt, projects, archived, errors)
  log.info("sync finished", {
    durationMs: final.durationMs,
    projects: final.projects.length,
    archived: final.archived.length,
    errors: final.errors.length,
  })
  return final
}

function result(
  date: string,
  dryRun: boolean,
  startedAt: number,
  projects: ProjectSyncResult[],
  archived: SyncResult["archived"],
  errors: SyncError[],
): SyncResult {
  return {
    date,
    dryRun,
    durationMs: Date.now() - startedAt,
    projects,
    archived,
    errors,
  }
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}
