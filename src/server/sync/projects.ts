import { sdk as clockin } from "@miranum/client-clockin"
import type { Client as ClockInClient } from "@miranum/client-clockin"
import { withRetry } from "../lib/concurrency.js"
import type { Logger } from "../lib/log.js"
import type { DimaconProjectInfo } from "./enrichment.js"
import { splitZipCity, startDateForClockin } from "./time.js"
import type { CustomerMapping, ProjectSyncResult } from "./types.js"

interface ClockinProjectRow {
  id?: number
  name?: string
  number?: string | null
  start_date?: string | null
}

interface ClockinProjectEmployeeRow {
  id?: number
}

export interface UpsertInput {
  date: string
  project: DimaconProjectInfo
  customer: CustomerMapping
  desiredEmployeeIds: number[]
}

export class ProjectUpserter {
  constructor(
    private readonly client: ClockInClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
  ) {}

  async upsert(input: UpsertInput): Promise<ProjectSyncResult> {
    const { date, project, customer, desiredEmployeeIds } = input

    const found = await this.findByNumber(project.id)

    if (!found) {
      return this.createNew(date, project, customer, desiredEmployeeIds)
    }

    return this.updateExisting(date, project, customer, found.id!, desiredEmployeeIds)
  }

  private async findByNumber(dimaconProjectId: string): Promise<ClockinProjectRow | null> {
    const result = (await withRetry(() =>
      clockin.searchForProjects({
        client: this.client,
        body: { scopes: [{ name: "byNumber", parameters: [dimaconProjectId] }] },
      }),
    )) as unknown as { data?: ClockinProjectRow[] }

    const row = result.data?.[0]
    return row?.id !== undefined ? row : null
  }

  private async createNew(
    date: string,
    project: DimaconProjectInfo,
    customer: CustomerMapping,
    desiredEmployeeIds: number[],
  ): Promise<ProjectSyncResult> {
    if (this.dryRun) {
      this.log.info("[dryRun] would create project", {
        dimaconProjectId: project.id,
        name: project.name,
      })
      return {
        dimaconProjectId: project.id,
        name: project.name,
        status: "created",
        employeesAttached: desiredEmployeeIds,
      }
    }

    const { zip, city } = splitZipCity(project.zipCity)
    const created = (await withRetry(() =>
      clockin.createProject({
        client: this.client,
        body: {
          name: project.name,
          number: project.id,
          customer_id: customer.clockinId,
          destination_street: project.street || null,
          destination_zip: zip || null,
          destination_city: city || null,
          start_date: startDateForClockin(date),
        },
      }),
    )) as unknown as { data?: { id?: number } }

    const clockinId = created.data?.id
    if (clockinId === undefined) {
      return {
        dimaconProjectId: project.id,
        name: project.name,
        status: "failed",
        reason: "clockin createProject returned no id",
      }
    }

    if (desiredEmployeeIds.length > 0) {
      await withRetry(() =>
        clockin.attachEmployees({
          client: this.client,
          path: { project: clockinId },
          body: { resources: desiredEmployeeIds },
        }),
      )
    }

    return {
      dimaconProjectId: project.id,
      clockinProjectId: clockinId,
      name: project.name,
      status: "created",
      employeesAttached: desiredEmployeeIds,
    }
  }

  private async updateExisting(
    date: string,
    project: DimaconProjectInfo,
    customer: CustomerMapping,
    clockinId: number,
    desiredEmployeeIds: number[],
  ): Promise<ProjectSyncResult> {
    const newStart = startDateForClockin(date)
    const startChanged = true

    const currentEmployees = await this.listEmployees(clockinId)
    const desired = new Set(desiredEmployeeIds)
    const current = new Set(currentEmployees)
    const toAdd = [...desired].filter((id) => !current.has(id))
    const toRemove = [...current].filter((id) => !desired.has(id))

    if (this.dryRun) {
      this.log.info("[dryRun] would update project", {
        clockinProjectId: clockinId,
        toAdd,
        toRemove,
      })
      return {
        dimaconProjectId: project.id,
        clockinProjectId: clockinId,
        name: project.name,
        status: toAdd.length || toRemove.length ? "updated" : "unchanged",
        employeesAttached: toAdd,
        employeesDetached: toRemove,
      }
    }

    if (startChanged) {
      await withRetry(() =>
        clockin.updateProject({
          client: this.client,
          path: { project: clockinId },
          body: {
            name: project.name,
            number: project.id,
            customer_id: customer.clockinId,
            start_date: newStart,
          },
        }),
      )
    }

    if (toAdd.length > 0) {
      await withRetry(() =>
        clockin.attachEmployees({
          client: this.client,
          path: { project: clockinId },
          body: { resources: toAdd },
        }),
      )
    }
    if (toRemove.length > 0) {
      await withRetry(() =>
        clockin.detachEmployees({
          client: this.client,
          path: { project: clockinId },
          body: { resources: toRemove },
        }),
      )
    }

    return {
      dimaconProjectId: project.id,
      clockinProjectId: clockinId,
      name: project.name,
      status: toAdd.length || toRemove.length ? "updated" : "unchanged",
      employeesAttached: toAdd,
      employeesDetached: toRemove,
    }
  }

  private async listEmployees(clockinProjectId: number): Promise<number[]> {
    const result = (await withRetry(() =>
      clockin.getAListOfProjectEmployees({
        client: this.client,
        path: { project: clockinProjectId },
      }),
    )) as unknown as { data?: ClockinProjectEmployeeRow[] }
    return (result.data ?? []).map((e) => e.id).filter((x): x is number => x !== undefined)
  }
}
