import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { createLimit, withRetry } from "../../lib/concurrency.js"
import { loadCustomersById, loadJobBundles } from "../shared/dimacon.js"
import type { DimaconCustomerInfo, DimaconJobBundle } from "../shared/dimacon.js"

export interface DimaconProjectInfo {
  id: string
  name: string
  street: string
  zipCity: string
  customAttributeValues?: { attributeId: string; value?: string }[]
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
  // Reine Dimacon-Reads ⇒ Parallelität dieses Systems (CONCURRENCY_DIMACON).
  const limit = createLimit("dimacon")

  const jobsPromise = loadJobBundles(client, jobIds, limit)

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
    loadCustomersById(client, customerIds, limit),
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
