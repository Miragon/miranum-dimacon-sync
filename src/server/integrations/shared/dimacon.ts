import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { createLimit, withRetry } from "../../lib/concurrency.js"
import { nextDay } from "./time.js"

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
  /** total = alle Termine des Datums (inkl. archivierte), live = nach Filter */
  counts: { total: number; live: number }
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
  description?: string
  customAttributeValues?: { attributeId: string; value?: string }[]
}

export async function loadAppointments(
  client: DimaconClient,
  date: string,
): Promise<LoadedAppointments> {
  const result = (await withRetry(() =>
    dimacon.getAllJobAppointmentsInPeriod({
      client,
      // `to` wirkt exklusiv (Start des Tages): Termine tragen Datetimes,
      // ein from=to-Fenster ist daher immer leer. Folgetag anfragen und
      // lokal aufs angefragte Datum filtern.
      query: { from: date, to: nextDay(date) },
    }),
  )) as unknown as {
    id: string
    jobId: string
    teamId: string
    date: string
    isArchived: boolean
  }[]

  const forDate = result.filter((a) => a.date.startsWith(date))
  const live = forDate.filter((a) => !a.isArchived)
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
    counts: { total: forDate.length, live: live.length },
  }
}

export async function loadJobBundles(
  client: DimaconClient,
  jobIds: string[],
  limit = createLimit("dimacon"),
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

export type DimaconEmployeeRole = "CRAFTSMAN" | "CONSTRUCTION_LEADER" | "BACKOFFICE" | "INSPECTOR"

export interface DimaconEmployeeFull {
  id: string
  firstName: string
  lastName: string
  personnelNumber?: string
  phoneNumber?: string
  team?: string
  additionalInformation?: string
  /** Wird nur geladen, damit das Voll-Replace-PUT es zurückspiegeln kann. */
  profilePicture?: string
  role: DimaconEmployeeRole
  color: string
  timeTrackingActive: boolean
  isArchived: boolean
  /** E-Mail des zugehörigen User-Kontos — liegt in Dimacon nicht am Mitarbeiter */
  email?: string
}

export async function loadEmployeesWithEmail(
  client: DimaconClient,
): Promise<DimaconEmployeeFull[]> {
  const [employees, users] = await Promise.all([
    withRetry(() => dimacon.getAllEmployees({ client })) as Promise<unknown>,
    withRetry(() => dimacon.getAllUsers({ client })) as Promise<unknown>,
  ])

  const emailByEmployeeId = new Map(
    (users as { employeeId?: string; emailAddress?: string }[])
      .filter((u) => u.employeeId && u.emailAddress)
      .map((u) => [u.employeeId as string, u.emailAddress as string]),
  )

  return (
    employees as {
      id: string
      firstName: string
      lastName: string
      personnelNumber?: string
      phoneNumber?: string
      team?: string
      additionalInformation?: string
      profilePicture?: string
      role: DimaconEmployeeRole
      color: string
      timeTrackingActive: boolean
      isArchived: boolean
    }[]
  ).map((e) => ({
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    personnelNumber: e.personnelNumber,
    phoneNumber: e.phoneNumber,
    team: e.team,
    additionalInformation: e.additionalInformation,
    profilePicture: e.profilePicture,
    role: e.role,
    color: e.color,
    timeTrackingActive: e.timeTrackingActive,
    isArchived: e.isArchived,
    email: emailByEmployeeId.get(e.id),
  }))
}

export async function loadAllCustomers(client: DimaconClient): Promise<DimaconCustomerInfo[]> {
  const rows = await withRetry(() => dimacon.allCustomers({ client }))
  return rows as unknown as DimaconCustomerInfo[]
}

export async function loadCustomersById(
  client: DimaconClient,
  customerIds: string[],
  limit = createLimit("dimacon"),
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
