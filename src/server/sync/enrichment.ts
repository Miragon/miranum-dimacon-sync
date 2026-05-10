import { sdk as dimacon } from "@miranum/client-dimacon"
import type { Client as DimaconClient } from "@miranum/client-dimacon"
import { createLimit, withRetry } from "../lib/concurrency.js"

export interface DimaconJobBundle {
  jobId: string
  projectId: string
  customerId: string
  teamAssignments: { employeeId: string; date: string; teamId?: string; isFixed: boolean }[]
}

export interface DimaconProjectInfo {
  id: string
  name: string
  street: string
  zipCity: string
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

export interface DimaconEmployeeInfo {
  id: string
  firstName: string
  lastName: string
  email?: string
}

export interface EnrichedDimaconData {
  jobs: Map<string, DimaconJobBundle>
  projects: Map<string, DimaconProjectInfo>
  customers: Map<string, DimaconCustomerInfo>
  employees: Map<string, DimaconEmployeeInfo>
}

export async function enrich(
  client: DimaconClient,
  jobIds: string[],
): Promise<EnrichedDimaconData> {
  const limit = createLimit()

  const jobsPromise = Promise.all(
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

  const employeesPromise = withRetry(() => dimacon.getAllEmployees({ client })).then((rows) =>
    (
      rows as unknown as {
        id: string
        firstName: string
        lastName: string
      }[]
    ).map(
      (e): DimaconEmployeeInfo => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
      }),
    ),
  )

  const usersPromise = withRetry(() => dimacon.getAllUsers({ client })).then(
    (rows) =>
      rows as unknown as {
        employeeId: string
        emailAddress: string
      }[],
  )

  const jobs = await jobsPromise
  const projectIds = unique(jobs.map((j) => j.projectId))
  const customerIds = unique(jobs.map((j) => j.customerId))

  const [projects, customers, employees, users] = await Promise.all([
    Promise.all(
      projectIds.map((projectId) =>
        limit(() =>
          withRetry(() => dimacon.getProjectById({ client, path: { projectId } })).then(
            (p) => p as unknown as DimaconProjectInfo,
          ),
        ),
      ),
    ),
    Promise.all(
      customerIds.map((customerId) =>
        limit(() =>
          withRetry(() => dimacon.getCustomerById({ client, path: { customerId } })).then(
            (c) => c as unknown as DimaconCustomerInfo,
          ),
        ),
      ),
    ),
    employeesPromise,
    usersPromise,
  ])

  const emailByEmployeeId = new Map(users.map((u) => [u.employeeId, u.emailAddress]))
  const employeesWithEmail = employees.map((e) => ({
    ...e,
    email: emailByEmployeeId.get(e.id),
  }))

  return {
    jobs: new Map(jobs.map((j) => [j.jobId, j])),
    projects: new Map(projects.map((p) => [p.id, p])),
    customers: new Map(customers.map((c) => [c.id, c])),
    employees: new Map(employeesWithEmail.map((e) => [e.id, e])),
  }
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}
