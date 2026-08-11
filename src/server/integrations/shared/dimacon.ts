import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { createLimit, withRetry } from "../../lib/concurrency.js"

export interface AppointmentForDate {
  id: string
  jobId: string
  teamId: string
  date: string
  isArchived: boolean
}

export interface LoadedAppointments {
  appointments: AppointmentForDate[]
  jobIds: string[]
  byJobId: Map<string, AppointmentForDate[]>
}

export interface DimaconJobBundle {
  jobId: string
  projectId: string
  customerId: string
  teamAssignments: { employeeId: string; date: string; teamId?: string; isFixed: boolean }[]
}

export interface DimaconCustomerInfo {
  id: string
  customerNumber?: string
  name: string
  street?: string
  zipCity?: string
  phoneNumber?: string
  email?: string
}

export async function loadAppointments(
  client: DimaconClient,
  date: string,
): Promise<LoadedAppointments> {
  const result = (await dimacon.getAllJobAppointmentsInPeriod({
    client,
    query: { from: date, to: date },
  })) as unknown as {
    id: string
    jobId: string
    teamId: string
    date: string
    isArchived: boolean
  }[]

  const live = result.filter((a) => !a.isArchived)
  const byJobId = new Map<string, AppointmentForDate[]>()
  for (const a of live) {
    const list = byJobId.get(a.jobId) ?? []
    list.push(a)
    byJobId.set(a.jobId, list)
  }

  return {
    appointments: live,
    jobIds: [...new Set(live.map((a) => a.jobId))],
    byJobId,
  }
}

export async function loadJobBundles(
  client: DimaconClient,
  jobIds: string[],
  limit = createLimit(),
): Promise<DimaconJobBundle[]> {
  return Promise.all(
    jobIds.map((jobId) =>
      limit(async () => {
        const data = (await withRetry(() =>
          dimacon.getJobById({ client, path: { jobId } }),
        )) as unknown as {
          job: { id: string; projectId: string; customerId: string }
          teamAssignments: {
            employeeId: string
            date: string
            teamId?: string
            isFixed: boolean
          }[]
        }
        return {
          jobId: data.job.id,
          projectId: data.job.projectId,
          customerId: data.job.customerId,
          teamAssignments: data.teamAssignments,
        } satisfies DimaconJobBundle
      }),
    ),
  )
}

export async function loadAllCustomers(client: DimaconClient): Promise<DimaconCustomerInfo[]> {
  const rows = await withRetry(() => dimacon.allCustomers({ client }))
  return rows as unknown as DimaconCustomerInfo[]
}

export async function loadCustomersById(
  client: DimaconClient,
  customerIds: string[],
  limit = createLimit(),
): Promise<DimaconCustomerInfo[]> {
  return Promise.all(
    customerIds.map((customerId) =>
      limit(() =>
        withRetry(() => dimacon.getCustomerById({ client, path: { customerId } })).then(
          (c) => c as unknown as DimaconCustomerInfo,
        ),
      ),
    ),
  )
}
