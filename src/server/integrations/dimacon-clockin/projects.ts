import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { NON_IDEMPOTENT_RETRY, withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconProjectInfo } from "./enrichment.js"
import type { ClockinProjectLookup, ClockinProjectRow } from "./project-lookup.js"
import { projectSourceValues } from "../shared/field-catalog.js"
import { applyMapping, diffMappedFields } from "../shared/field-mapping.js"
import type { AppliedMapping } from "../shared/field-mapping.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { startDateForClockin } from "../shared/time.js"
import type { CustomerMapping, ProjectSyncResult, SyncSteps } from "./types.js"

interface ClockinProjectEmployeeRow {
  id?: number
}

// Bodies werden aus der Feld-Zuordnung dynamisch aufgebaut; die Gültigkeit
// der Feldnamen sichert validateRules + der Katalog, nicht der Compiler.
type ProjectWriteBody = NonNullable<Parameters<typeof clockin.createProject>[0]>["body"]

export interface UpsertInput {
  date: string
  project: DimaconProjectInfo
  /**
   * null, wenn der Kunde in Clockin nicht aufgelöst wurde — Kunden-Schritt
   * deaktiviert, Suche fehlgeschlagen oder mehrdeutige Kandidaten.
   */
  customer: CustomerMapping | null
  desiredEmployeeIds: number[]
}

export class ProjectUpserter {
  constructor(
    private readonly client: ClockInClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
    private readonly steps: SyncSteps,
    private readonly mapping: EntityMappingContext,
    private readonly onMappingWarning: (message: string) => void = () => undefined,
    /**
     * Wird SOFORT nach Auflösung/Anlage der Clockin-ID gerufen — auch wenn
     * spätere Schritte desselben Projekts fehlschlagen. Die Archiv-Phase
     * darf nur Projekte archivieren, die hier nie gemeldet wurden.
     */
    private readonly onResolved: (clockinProjectId: number) => void = () => undefined,
    /**
     * Vorab gebündelt geladene Clockin-Projekte (`searchForProjects` mit
     * mehreren Nummern + `includes:employees`). Vorhanden = weder eine Suche
     * noch ein `getAListOfProjectEmployees` je Projekt.
     */
    private readonly prefetched?: ClockinProjectLookup,
  ) {}

  /** Einmalige Diagnose je Lauf — s. `warnAboutMissingTargets`. */
  private warnedMissingTargets = false

  async upsert(input: UpsertInput): Promise<ProjectSyncResult> {
    const { date, project, customer, desiredEmployeeIds } = input

    // Auch bei deaktivierten Schritten immer auflösen: die Archiv-Phase
    // schützt nur Projekte, deren Clockin-ID dieser Lauf kennt.
    const found = await this.resolveRow(project.id)
    if (found?.id !== undefined) this.onResolved(found.id)

    if (!found) {
      if (!this.steps.projects) {
        return {
          dimaconProjectId: project.id,
          name: project.name,
          status: "skipped",
          reason: "Projekt-Schritt deaktiviert — Projekt existiert nicht in Clockin",
        }
      }
      if (!customer) {
        return {
          dimaconProjectId: project.id,
          name: project.name,
          status: "skipped",
          reason: "Kunde in Clockin nicht aufgelöst — Projekt nicht angelegt",
        }
      }
      return this.createNew(date, project, customer, desiredEmployeeIds)
    }

    return this.updateExisting(date, project, customer, found, desiredEmployeeIds)
  }

  private applyProjectMapping(project: DimaconProjectInfo): AppliedMapping {
    const applied = applyMapping(
      this.mapping.rules,
      this.mapping.catalog,
      this.mapping.discovery,
      projectSourceValues(project),
    )
    for (const warning of applied.warnings) {
      this.onMappingWarning(`Projekt ${project.name}: ${warning.message}`)
    }
    return applied
  }

  /**
   * `startDate` ist ein PARAMETER, kein abgeleiteter Wert: beim Anlegen das
   * Sync-Datum, beim Update der Bestandswert der Clockin-Zeile. Vorher wurde
   * er täglich neu gesetzt — damit war der Änderungsvergleich für jedes an
   * einem anderen Tag synchronisierte Projekt per Definition wahr und jeder
   * Lauf schrieb praktisch jedes Projekt (Issue #15).
   */
  private buildBody(
    startDate: string,
    project: DimaconProjectInfo,
    customer: CustomerMapping,
    applied: AppliedMapping,
    extra: Record<string, unknown> = {},
  ): ProjectWriteBody {
    return {
      ...applied.standardFields,
      number: project.id,
      customer_id: customer.clockinId,
      start_date: startDate,
      ...(applied.customFields.length > 0 ? { custom_fields: applied.customFields } : {}),
      ...extra,
    } as ProjectWriteBody
  }

  /**
   * Clockin-Zeile zur Dimacon-Projektnummer. Mit Prefetch ohne Request; die
   * Einzelsuche bleibt der Fallback (kein Prefetch bzw. Prefetch-Fehler).
   */
  private async resolveRow(dimaconProjectId: string): Promise<ClockinProjectRow | null> {
    if (this.prefetched) {
      const rows = this.prefetched.get(dimaconProjectId)
      if (rows.length > 1) {
        // Der Index ist mehrwertig — Mehrdeutigkeit bleibt sichtbar, statt
        // still auf den ersten Treffer zu kollabieren.
        this.log.warn("multiple clockin projects share one dimacon number", {
          dimaconProjectId,
          clockinProjectIds: rows.map((r) => r.id),
        })
      }
      return rows[0] ?? null
    }
    return this.findByNumber(dimaconProjectId)
  }

  private async findByNumber(dimaconProjectId: string): Promise<ClockinProjectRow | null> {
    const includes: { relation: "employees" | "customFields" }[] = []
    // Mitarbeiter gleich mitladen — spart das getAListOfProjectEmployees.
    if (this.steps.assignments) includes.push({ relation: "employees" })
    if (this.mapping.hasCustomTargets) includes.push({ relation: "customFields" })

    const result = (await withRetry(() =>
      clockin.searchForProjects({
        client: this.client,
        body: {
          scopes: [{ name: "byNumber", parameters: [dimaconProjectId] }],
          ...(includes.length > 0 ? { includes } : {}),
        },
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
    const applied = this.applyProjectMapping(project)

    if (this.dryRun) {
      this.log.info("[dryRun] would create project", {
        dimaconProjectId: project.id,
        name: project.name,
        mappedStandard: Object.keys(applied.standardFields),
        mappedCustom: applied.customFields.map((f) => f.custom_field_id),
      })
      return {
        dimaconProjectId: project.id,
        name: project.name,
        status: "created",
        employeesAttached: desiredEmployeeIds,
      }
    }

    const created = (await withRetry(
      () =>
        clockin.createProject({
          client: this.client,
          // Anlage: das Startdatum ist das Sync-Datum.
          body: this.buildBody(startDateForClockin(date), project, customer, applied),
        }),
      // Anlage ist nicht idempotent (s. NON_IDEMPOTENT_RETRY): ein Retry nach
      // serverseitig erfolgtem Insert legte ein zweites Projekt an.
      NON_IDEMPOTENT_RETRY,
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
    // Frisch angelegt = eingeplant — sofort vor der Archiv-Phase schützen,
    // auch wenn attachEmployees gleich fehlschlägt.
    this.onResolved(clockinId)

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
    customer: CustomerMapping | null,
    row: ClockinProjectRow,
    desiredEmployeeIds: number[],
  ): Promise<ProjectSyncResult> {
    const clockinId = row.id!
    const applied = this.steps.projects ? this.applyProjectMapping(project) : null

    // Nur schreiben, wenn sich tatsächlich etwas geändert hat — jeder Lauf
    // trifft sonst das Clockin-Rate-Limit. `archived` fängt gestern durch
    // archiveUnplanned archivierte Projekte, die heute wieder eingeplant sind.
    const mappedDiff = applied
      ? diffMappedFields(applied, {
          standard: row as unknown as Record<string, string | null | undefined>,
          customFields: new Map(
            (row.customFields ?? [])
              .filter((f) => f.custom_field_id !== undefined)
              .map((f) => [f.custom_field_id as number, f.value]),
          ),
        })
      : { changed: false, changes: [] }

    // `start_date` steht bewusst NICHT mehr im Vergleich (Issue #15): es
    // wurde bei jedem Lauf auf das Sync-Datum gesetzt und war damit für jedes
    // an einem anderen Tag synchronisierte Projekt per Definition „geändert" —
    // der Schutz „nur bei Änderung schreiben" war dadurch wirkungslos. Das
    // Clockin-Startdatum bleibt künftig auf dem Wert der Anlage stehen.
    const fieldsChanged =
      applied !== null &&
      (row.archived === true || (row.number ?? "") !== project.id || mappedDiff.changed)

    if (applied) this.warnAboutMissingTargets(applied, row)

    // Der volle Update-Body braucht customer_id — ohne aufgelösten Kunden
    // werden Feld-Updates übersprungen.
    const canWriteFields = fieldsChanged && customer !== null
    const skippedFieldUpdate = fieldsChanged && customer === null

    // Wieder eingeplante, zuvor archivierte Projekte auch dann reaktivieren,
    // wenn Feld-Updates gerade nicht möglich sind (Schritt aus / Kunde
    // fehlt) — die Merge-Semantik der API macht den Minimal-Body gefahrlos.
    const needsBareUnarchive = row.archived === true && !canWriteFields

    let toAdd: number[] = []
    let toRemove: number[] = []
    if (this.steps.assignments) {
      const currentEmployees = await this.currentEmployees(row, clockinId)
      const desired = new Set(desiredEmployeeIds)
      const current = new Set(currentEmployees)
      toAdd = [...desired].filter((id) => !current.has(id))
      toRemove = [...current].filter((id) => !desired.has(id))
    }

    const changed = canWriteFields || needsBareUnarchive || toAdd.length > 0 || toRemove.length > 0
    const reason = skippedFieldUpdate
      ? "Feld-Update übersprungen: Kunde in Clockin nicht aufgelöst"
      : undefined

    if (this.dryRun) {
      this.log.info("[dryRun] would update project", {
        clockinProjectId: clockinId,
        fieldsChanged,
        mappedChanges: mappedDiff.changes,
        skippedFieldUpdate,
        unarchive: row.archived === true,
        toAdd,
        toRemove,
      })
      return {
        dimaconProjectId: project.id,
        clockinProjectId: clockinId,
        name: project.name,
        status: changed ? "updated" : "unchanged",
        employeesAttached: toAdd,
        employeesDetached: toRemove,
        reason,
      }
    }

    if (canWriteFields && customer && applied) {
      await withRetry(() =>
        clockin.updateProject({
          client: this.client,
          path: { project: clockinId },
          // Update: Bestands-Startdatum zurückspiegeln. Korrekt bei Merge-
          // UND bei Replace-Semantik des Clockin-PUT (weglassen wäre es nur
          // bei Merge — die Semantik ist nicht dokumentiert).
          body: this.buildBody(
            row.start_date ?? startDateForClockin(date),
            project,
            customer,
            applied,
            {
              archived: false,
            },
          ),
        }),
      )
    } else if (needsBareUnarchive) {
      await withRetry(() =>
        clockin.updateProject({
          client: this.client,
          path: { project: clockinId },
          body: { name: row.name ?? project.name, archived: false },
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
      status: changed ? "updated" : "unchanged",
      employeesAttached: toAdd,
      employeesDetached: toRemove,
      reason,
    }
  }

  /**
   * Aktuelle Belegschaft des Projekts. Trägt die Zeile ein `employees`-Array
   * (Prefetch bzw. Einzelsuche mit `includes:employees`), entfällt der
   * Request je Projekt komplett. Ein LEERES Array ist eine gültige Antwort —
   * deshalb `Array.isArray` statt eines Truthy-Checks.
   */
  private async currentEmployees(row: ClockinProjectRow, clockinId: number): Promise<number[]> {
    if (Array.isArray(row.employees)) {
      return row.employees.map((e) => e.id).filter((x): x is number => x !== undefined)
    }
    return this.listEmployees(clockinId)
  }

  /**
   * Diagnose zum im Issue vermuteten „immer geändert"-Fall: taucht ein
   * gemapptes Zielfeld in der Such-Zeile gar nicht als Key auf, vergleicht
   * `diffMappedFields` gegen `undefined` und meldet jeden Lauf eine Änderung.
   * Bewusst nur eine Warnung — die Vergleichssemantik bleibt unangetastet.
   */
  private warnAboutMissingTargets(applied: AppliedMapping, row: ClockinProjectRow): void {
    if (this.warnedMissingTargets) return
    const missing = Object.keys(applied.standardFields).filter(
      (field) => !Object.prototype.hasOwnProperty.call(row, field),
    )
    if (missing.length === 0) return
    this.warnedMissingTargets = true
    this.log.warn("mapped project fields missing from the clockin search row", {
      fields: missing,
      hint: "der Feldvergleich meldet sie deshalb bei jedem Lauf als geändert",
    })
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
