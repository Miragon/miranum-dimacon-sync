import { sdk as dimacon } from "@miranum/client-dimacon"
import type { Client as DimaconClient } from "@miranum/client-dimacon"

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
