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

/**
 * Schwelle für die Sammelabrufe. Darunter sind Einzelabrufe billiger als ein
 * Vollabruf: bei 5 Terminen am Tag kosten 5 `getProjectById` weniger als ein
 * `getAllProjects` über mehrere tausend Projekte. Darüber dreht sich das
 * Verhältnis — ein Request statt N.
 */
export const BULK_FETCH_THRESHOLD = 8

/** Projekt-Stammdaten, wie sie `getProjectById` UND `getAllProjects` liefern. */
export interface DimaconProjectInfo {
  id: string
  name: string
  street: string
  zipCity: string
  customAttributeValues?: { attributeId: string; value?: string }[]
}

/** Termin, wie ihn `getAllJobsInPeriod` am Auftrag mitliefert. */
export interface DimaconJobAppointment {
  id: string
  jobId: string
  teamId: string
  date: string
  isArchived: boolean
}

/** Auftrag aus dem Zeitraum-Abruf — trägt Projekt, Kunde und seine Termine. */
export interface DimaconPeriodJob {
  jobId: string
  projectId: string
  customerId: string
  appointments: DimaconJobAppointment[]
}

/** Team-Zuweisung aus dem Zeitraum-Abruf (trägt KEINE jobId — s. Join unten). */
export interface DimaconTeamAssignment {
  employeeId: string
  date: string
  teamId?: string
  isFixed: boolean
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

/**
 * Alle Termine eines Zeitraums (inkl. archivierter — der Aufrufer filtert).
 * `to` wirkt exklusiv (Start des Tages): Termine tragen Datetimes, ein
 * from=to-Fenster ist deshalb immer leer.
 */
export async function loadAppointmentsInPeriod(
  client: DimaconClient,
  from: string,
  to: string,
): Promise<AppointmentForDate[]> {
  const result = (await withRetry(() =>
    dimacon.getAllJobAppointmentsInPeriod({ client, query: { from, to } }),
  )) as unknown as AppointmentForDate[]
  return result ?? []
}

export async function loadAppointments(
  client: DimaconClient,
  date: string,
): Promise<LoadedAppointments> {
  const result = await loadAppointmentsInPeriod(client, date, nextDay(date))

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

/**
 * Alle Aufträge eines Zeitraums in EINEM Request (statt `getJobById` je
 * Auftrag). Die Antwort trägt die Termine des Auftrags mit — daraus leitet
 * der Lauf sowohl die Tagesplanung als auch den Archiv-Horizont ab.
 *
 * `to` wirkt wie bei den Terminen exklusiv; der Aufrufer übergibt bereits
 * den Folgetag bzw. das Horizont-Ende.
 */
export async function loadJobsInPeriod(
  client: DimaconClient,
  from: string,
  to: string,
): Promise<DimaconPeriodJob[]> {
  const rows = (await withRetry(() =>
    dimacon.getAllJobsInPeriod({ client, query: { from, to } }),
  )) as unknown as {
    id: string
    projectId: string
    customerId: string
    appointments?: DimaconJobAppointment[]
  }[]

  return rows.map((job) => ({
    jobId: job.id,
    projectId: job.projectId,
    customerId: job.customerId,
    appointments: job.appointments ?? [],
  }))
}

/**
 * Alle Team-Zuweisungen eines Zeitraums in EINEM Request. `TeamAssignmentTo`
 * trägt KEINE jobId — die Zuordnung zum Auftrag läuft deshalb über
 * (teamId, Datum) seiner Termine. Genau deshalb probt `enrich` das Ergebnis
 * einmalig gegen `getJobById` und fällt bei Abweichung komplett auf die
 * Einzelabrufe zurück.
 */
export async function loadTeamAssignmentsInPeriod(
  client: DimaconClient,
  from: string,
  to: string,
): Promise<DimaconTeamAssignment[]> {
  const rows = (await withRetry(() =>
    dimacon.getCurrentTeamAssignments({ client, query: { from, to } }),
  )) as unknown as DimaconTeamAssignment[]
  return rows ?? []
}

/** Gesamter Projektbestand in EINEM Request (gleiche Form wie getProjectById). */
export async function loadAllProjects(client: DimaconClient): Promise<DimaconProjectInfo[]> {
  const rows = await withRetry(() => dimacon.getAllProjects({ client }))
  return rows as unknown as DimaconProjectInfo[]
}

/** Einzelabruf-Pfad: ein `getProjectById` je Id, gedrosselt über das Limit. */
export async function loadProjectsById(
  client: DimaconClient,
  projectIds: string[],
  limit = createLimit("dimacon"),
): Promise<DimaconProjectInfo[]> {
  return Promise.all(
    projectIds.map((projectId) =>
      limit(() =>
        withRetry(() => dimacon.getProjectById({ client, path: { projectId } })).then(
          (p) => p as unknown as DimaconProjectInfo,
        ),
      ),
    ),
  )
}
