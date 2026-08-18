import { z } from "zod"
import type { EmployeeSyncCounts, EmployeeSyncRow } from "./employee-sync/types.js"

/**
 * Zuschaltbare Phasen des Clockin-Syncs. `employees` ist der bidirektionale
 * Mitarbeiter-Stammdaten-Abgleich (läuft vor der Tagesplanung),
 * `assignments` die Mitarbeiter-Zuordnung auf Projekte. Teilobjekte wie
 * `{archive:false}` werden durch die inneren Defaults vervollständigt;
 * fehlt `steps` ganz (auch beim Scheduler-`parse({})`), läuft alles.
 */
export const SyncStepsSchema = z.object({
  employees: z.boolean().default(true),
  customers: z.boolean().default(true),
  projects: z.boolean().default(true),
  assignments: z.boolean().default(true),
  archive: z.boolean().default(true),
})

export type SyncSteps = z.infer<typeof SyncStepsSchema>

export const DEFAULT_STEPS: SyncSteps = {
  employees: true,
  customers: true,
  projects: true,
  assignments: true,
  archive: true,
}

export const SyncRunInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  dryRun: z.boolean().optional(),
  steps: SyncStepsSchema.optional(),
})

export type SyncRunInput = z.infer<typeof SyncRunInputSchema>

export type ProjectStatus = "created" | "updated" | "unchanged" | "skipped" | "failed"

export interface ProjectSyncResult {
  dimaconProjectId: string
  clockinProjectId?: number
  name: string
  status: ProjectStatus
  employeesAttached?: number[]
  employeesDetached?: number[]
  reason?: string
}

export interface ArchiveResult {
  clockinProjectId: number
  name: string
}

export interface SyncError {
  scope:
    | "appointments"
    | "enrichment"
    | "customer"
    | "employee"
    | "project"
    | "archive"
    | "mapping"
    | "load"
  refId?: string
  message: string
}

export interface SyncResult {
  date: string
  dryRun: boolean
  durationMs: number
  steps: SyncSteps
  /** Termine in Dimacon für das Datum — macht "nichts zu tun" erklärbar */
  appointments: { total: number; live: number }
  /** Ergebnis des Mitarbeiter-Stammdaten-Abgleichs — fehlt bei deaktiviertem Schritt */
  employeeSync?: {
    counts: EmployeeSyncCounts
    rows: EmployeeSyncRow[]
  }
  projects: ProjectSyncResult[]
  archived: ArchiveResult[]
  errors: SyncError[]
}

export interface EmployeeMapping {
  dimaconId: string
  clockinId: number
  firstName: string
  lastName: string
}

export interface CustomerMapping {
  dimaconId: string
  clockinId: number
  number: string
  name: string
}
