import { sdk as clockin } from "@miranum/client-clockin"
import type { Client as ClockInClient } from "@miranum/client-clockin"
import { withRetry } from "../lib/concurrency.js"
import type { Logger } from "../lib/log.js"
import type { DimaconEmployeeInfo } from "./enrichment.js"
import type { EmployeeMapping } from "./types.js"

interface ClockinEmployeeRow {
  id?: number
  first_name?: string
  last_name?: string
  email?: string | null
}

export class EmployeeMatcher {
  private inflight = new Map<string, Promise<EmployeeMapping | null>>()

  constructor(
    private readonly client: ClockInClient,
    private readonly log: Logger,
  ) {}

  async match(employee: DimaconEmployeeInfo): Promise<EmployeeMapping | null> {
    const cached = this.inflight.get(employee.id)
    if (cached) return cached

    const promise = this.doMatch(employee)
    this.inflight.set(employee.id, promise)
    promise.catch(() => this.inflight.delete(employee.id))
    return promise
  }

  private async doMatch(employee: DimaconEmployeeInfo): Promise<EmployeeMapping | null> {
    const result = (await withRetry(() =>
      clockin.searchForEmployees({
        client: this.client,
        body: { scopes: [{ name: "byLastName", parameters: [employee.lastName] }] },
      }),
    )) as unknown as { data?: ClockinEmployeeRow[] }

    let candidates: ClockinEmployeeRow[] = result.data ?? []

    if (candidates.length > 1) {
      candidates = candidates.filter(
        (c) => normalize(c.first_name) === normalize(employee.firstName),
      )
    }

    if (candidates.length > 1 && employee.email) {
      candidates = candidates.filter(
        (c) => normalize(c.email ?? "") === normalize(employee.email ?? ""),
      )
    }

    if (candidates.length === 0) {
      this.log.warn("employee not found in clockin", {
        dimaconEmployeeId: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
      })
      return null
    }
    if (candidates.length > 1) {
      this.log.warn("ambiguous employee match", {
        dimaconEmployeeId: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
        candidates: candidates.length,
      })
      return null
    }

    const id = candidates[0].id
    if (id === undefined) return null

    return {
      dimaconId: employee.id,
      clockinId: id,
      firstName: employee.firstName,
      lastName: employee.lastName,
    }
  }
}

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase()
}
