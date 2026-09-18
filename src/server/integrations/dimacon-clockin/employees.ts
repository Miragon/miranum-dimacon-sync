import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import { personnelNumberKey } from "./employee-sync/matcher.js"
import type { DimaconEmployeeInfo } from "./enrichment.js"
import type { EmployeeMapping } from "./types.js"

interface ClockinEmployeeRow {
  id?: number
  personnel_number?: string | null
}

/**
 * Zuordnung Dimacon-Mitarbeiter → Clockin-Mitarbeiter für die Tagesplanung.
 * Wie im Stammdaten-Abgleich AUSSCHLIESSLICH über die Personalnummer — eine
 * Namenssuche als Fallback holte den Namen durch die Hintertür zurück (und
 * akzeptierte einen einzelnen Nachnamen-Treffer sogar ohne Vornamen-Prüfung).
 */
export class EmployeeMatcher {
  private inflight = new Map<string, Promise<EmployeeMapping | null>>()

  constructor(
    private readonly client: ClockInClient,
    private readonly log: Logger,
    /**
     * Vorab bekannte Paare (dimaconId → clockinId) aus dem Stammdaten-
     * Abgleich — erspart die Suche pro Mitarbeiter. Für nicht geseedete IDs
     * (z. B. Schritt deaktiviert) bleibt die Suche als Fallback aktiv.
     */
    private readonly seededPairs: ReadonlyMap<string, number> = new Map(),
  ) {}

  async match(employee: DimaconEmployeeInfo): Promise<EmployeeMapping | null> {
    const seeded = this.seededPairs.get(employee.id)
    if (seeded !== undefined) {
      return {
        dimaconId: employee.id,
        clockinId: seeded,
        firstName: employee.firstName,
        lastName: employee.lastName,
      }
    }

    const cached = this.inflight.get(employee.id)
    if (cached) return cached

    const promise = this.doMatch(employee)
    this.inflight.set(employee.id, promise)
    promise.catch(() => this.inflight.delete(employee.id))
    return promise
  }

  private async doMatch(employee: DimaconEmployeeInfo): Promise<EmployeeMapping | null> {
    const personnelNumber = employee.personnelNumber?.trim()
    if (!personnelNumber) {
      this.log.warn("employee without personnel number — not matched in clockin", {
        dimaconEmployeeId: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
      })
      return null
    }

    const result = (await withRetry(() =>
      clockin.searchForEmployees({
        client: this.client,
        body: { scopes: [{ name: "byPersonnelNumber", parameters: [personnelNumber] }] },
      }),
    )) as unknown as { data?: ClockinEmployeeRow[] }

    // Lokal exakt vergleichen: der Scope kennt Wildcards (`*`), und eine
    // unscharfe Serverantwort darf nie einen Treffer erzeugen.
    const key = personnelNumberKey(personnelNumber)
    const candidates = (result.data ?? []).filter(
      (c) => c.id !== undefined && personnelNumberKey(c.personnel_number ?? undefined) === key,
    )

    if (candidates.length === 0) {
      this.log.warn("employee not found in clockin", {
        dimaconEmployeeId: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
        personnelNumber,
      })
      return null
    }
    if (candidates.length > 1) {
      this.log.warn("ambiguous employee match", {
        dimaconEmployeeId: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
        personnelNumber,
        candidates: candidates.length,
      })
      return null
    }

    return {
      dimaconId: employee.id,
      clockinId: candidates[0].id as number,
      firstName: employee.firstName,
      lastName: employee.lastName,
    }
  }
}
