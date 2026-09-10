import { sdk as clockin } from "@miragon/client-clockin"
import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { withRetry } from "../../../lib/concurrency.js"
import type { Logger } from "../../../lib/log.js"
import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import { employeeSourceValues } from "../../shared/field-catalog.js"
import { applyMapping, diffMappedFields } from "../../shared/field-mapping.js"
import type { AppliedMapping } from "../../shared/field-mapping.js"
import type { EntityMappingContext } from "../../shared/mapping-context.js"
import { diffPair } from "./matcher.js"
import type { EmployeePair, PairDiff } from "./matcher.js"
import type { ClockinEmployeeInfo, EmployeeSyncRow } from "./types.js"

/** Zinc-400 — neutrale Default-Farbe für in Dimacon angelegte Mitarbeiter */
const DEFAULT_DIMACON_COLOR = "#A1A1AA"

// Bodies werden aus der Feld-Zuordnung dynamisch aufgebaut; die Gültigkeit
// der Feldnamen sichert validateRules + der Katalog.
type EmployeeWriteBody = NonNullable<Parameters<typeof clockin.createEmployee>[0]>["body"]

export class EmployeeSyncer {
  constructor(
    private readonly dimaconClient: DimaconClient,
    private readonly clockinClient: ClockInClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
    private readonly mapping: EntityMappingContext,
    private readonly onMappingWarning: (message: string) => void = () => undefined,
  ) {}

  private applyEmployeeMapping(e: DimaconEmployeeFull): AppliedMapping {
    const applied = applyMapping(
      this.mapping.rules,
      this.mapping.catalog,
      this.mapping.discovery,
      employeeSourceValues(e),
    )
    for (const warning of applied.warnings) {
      this.onMappingWarning(`Mitarbeiter ${e.firstName} ${e.lastName}: ${warning.message}`)
    }
    return applied
  }

  async createInClockin(e: DimaconEmployeeFull): Promise<EmployeeSyncRow> {
    const name = `${e.firstName} ${e.lastName}`

    if (this.dryRun) {
      this.log.info("[dryRun] would create clockin employee", { dimaconEmployeeId: e.id, name })
      return {
        direction: "dimacon→clockin",
        dimaconId: e.id,
        name,
        status: "created",
        reason: "[dryRun]",
      }
    }

    const applied = this.applyEmployeeMapping(e)
    // fillIfNonEmpty-Semantik: leere Werte fehlen im Body (Clockin validiert
    // z. B. phone_work als String — null wird abgelehnt).
    const created = (await withRetry(() =>
      clockin.createEmployee({
        client: this.clockinClient,
        body: {
          ...applied.standardFields,
          first_name: e.firstName,
          last_name: e.lastName,
          personnel_number: e.personnelNumber?.trim() || undefined,
          email: e.email ?? null,
          ...(applied.customFields.length > 0 ? { custom_fields: applied.customFields } : {}),
        } as EmployeeWriteBody,
      }),
    )) as unknown as { data?: { id?: number } }

    return {
      direction: "dimacon→clockin",
      dimaconId: e.id,
      clockinId: created.data?.id,
      name,
      status: "created",
    }
  }

  async createInDimacon(c: ClockinEmployeeInfo): Promise<EmployeeSyncRow> {
    const name = `${c.firstName} ${c.lastName}`

    if (this.dryRun) {
      this.log.info("[dryRun] would create dimacon employee", { clockinEmployeeId: c.id, name })
      return {
        direction: "clockin→dimacon",
        clockinId: c.id,
        name,
        status: "created",
        reason:
          "[dryRun] Rolle CRAFTSMAN (Default), ohne Team — in Dimacon manuell einem Team zuweisen",
      }
    }

    const created = (await withRetry(() =>
      dimacon.createNewEmployee({
        client: this.dimaconClient,
        body: {
          firstName: c.firstName,
          lastName: c.lastName,
          role: "CRAFTSMAN",
          personnelNumber: c.personnelNumber?.trim() || undefined,
          phoneNumber: c.phoneWork,
          color: DEFAULT_DIMACON_COLOR,
          timeTrackingActive: true,
        },
      }),
    )) as unknown as { id?: string }

    return {
      direction: "clockin→dimacon",
      dimaconId: created.id,
      clockinId: c.id,
      name,
      status: "created",
      reason: "Rolle CRAFTSMAN (Default), ohne Team — in Dimacon manuell einem Team zuweisen",
    }
  }

  /** Dimacon gewinnt bei Konflikten; Rückschreibung nur für die Personalnummer. */
  async alignPair(pair: EmployeePair): Promise<EmployeeSyncRow> {
    const { dimacon: d, clockin: c } = pair
    const base = {
      direction: "match" as const,
      dimaconId: d.id,
      clockinId: c.id,
      name: `${d.firstName} ${d.lastName}`,
    }

    if (d.isArchived) {
      return {
        ...base,
        status: "reported",
        reason: "in Dimacon archiviert, in Clockin weiterhin vorhanden",
      }
    }

    const diff = diffPair(d, c)
    const applied = this.applyEmployeeMapping(d)
    const mappedDiff = diffMappedFields(applied, {
      standard: (c.raw ?? { phone_work: c.phoneWork }) as Record<string, string | null | undefined>,
      customFields: new Map(
        (c.customFieldValues ?? [])
          .filter((f) => f.custom_field_id !== undefined)
          .map((f) => [f.custom_field_id as number, f.value]),
      ),
    })

    const needsClockinUpdate = diff.clockinChanges.length > 0 || mappedDiff.changed
    if (!needsClockinUpdate && !diff.backfillPersonnelNumber) {
      return { ...base, status: "unchanged" }
    }

    if (this.dryRun) {
      this.log.info("[dryRun] would align employee pair", {
        dimaconEmployeeId: d.id,
        clockinEmployeeId: c.id,
        changes: diff.clockinChanges,
        mappedChanges: mappedDiff.changes,
        backfillPersonnelNumber: diff.backfillPersonnelNumber ?? null,
      })
      return { ...base, status: "updated", reason: `[dryRun] ${describeDiff(diff, mappedDiff)}` }
    }

    if (needsClockinUpdate) {
      // fillIfNonEmpty-Semantik: leere Dimacon-Werte fehlen im Body und
      // lassen die Clockin-Werte unangetastet (Merge-Semantik der API).
      await withRetry(() =>
        clockin.updateEmployee({
          client: this.clockinClient,
          path: { employee: c.id },
          body: {
            ...applied.standardFields,
            first_name: d.firstName,
            last_name: d.lastName,
            // Clockin-E-Mail bleibt erhalten (fixiertes Feld)
            email: c.email ?? null,
            personnel_number: d.personnelNumber?.trim() || c.personnelNumber?.trim() || undefined,
            ...(applied.customFields.length > 0 ? { custom_fields: applied.customFields } : {}),
          } as EmployeeWriteBody,
        }),
      )
    }

    if (diff.backfillPersonnelNumber) {
      await withRetry(() =>
        dimacon.updateEmployee({
          client: this.dimaconClient,
          path: { employeeId: d.id },
          body: dimaconEmployeeUpdateBody(d, {
            personnelNumber: diff.backfillPersonnelNumber,
          }),
        }),
      )
    }

    return { ...base, status: "updated", reason: describeDiff(diff, mappedDiff) }
  }
}

/**
 * Dimacon-PUT ist ein Voll-Replace: bestehende Werte MÜSSEN zurückgespiegelt
 * werden, sonst werden sie gelöscht (Issue #17 — Mitarbeiter verloren beim
 * Personalnummer-Backfill ihr Team). Deshalb spiegelt der Body ALLE geladenen
 * Felder zurück und die Änderung kommt als `overrides` obendrauf.
 * `undefined`-Werte bleiben bewusst weg statt auf `null` normalisiert zu
 * werden — unter Merge-Semantik strikt sicherer, unter Replace identisch.
 */
function dimaconEmployeeUpdateBody(
  d: DimaconEmployeeFull,
  overrides: { personnelNumber?: string } = {},
): NonNullable<Parameters<typeof dimacon.updateEmployee>[0]>["body"] {
  return {
    role: d.role,
    firstName: d.firstName,
    lastName: d.lastName,
    personnelNumber: d.personnelNumber,
    phoneNumber: d.phoneNumber,
    team: d.team,
    profilePicture: d.profilePicture,
    color: d.color,
    timeTrackingActive: d.timeTrackingActive,
    additionalInformation: d.additionalInformation,
    ...overrides,
  }
}

function describeDiff(diff: PairDiff, mappedDiff?: { changes: string[] }): string {
  const parts: string[] = []
  const changes = [...diff.clockinChanges, ...(mappedDiff?.changes ?? [])]
  if (changes.length > 0) {
    parts.push(`Clockin angepasst: ${changes.join(", ")}`)
  }
  if (diff.backfillPersonnelNumber) {
    parts.push(`Personalnummer ${diff.backfillPersonnelNumber} nach Dimacon übernommen`)
  }
  return parts.join("; ")
}
