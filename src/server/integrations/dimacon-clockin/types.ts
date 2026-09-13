import { z } from "zod"
import type { EmployeeSyncCounts, EmployeeSyncRow } from "./employee-sync/types.js"

/**
 * Zuschaltbare Phasen des Clockin-Syncs. `employees` ist der bidirektionale
 * Mitarbeiter-Stammdaten-Abgleich (läuft vor der Tagesplanung),
 * `assignments` die Mitarbeiter-Zuordnung auf Projekte. Teilobjekte wie
 * `{archive:false}` werden durch die inneren Defaults vervollständigt;
 * fehlt `steps` ganz (auch beim Scheduler-`parse({})`), läuft alles.
 *
 * Ausnahme: `employeeCreateInDimacon` schaltet NUR die Anlage-Richtung
 * Clockin → Dimacon und ist bewusst per Default AUS (Issue #17 — der Sync hat
 * ungefiltert teamlose Mitarbeiter in Dimacon angelegt). Der Schalter greift
 * nur zusätzlich zu `employees`.
 */
export const SyncStepsSchema = z.object({
  employees: z.boolean().default(true),
  customers: z.boolean().default(true),
  projects: z.boolean().default(true),
  assignments: z.boolean().default(true),
  archive: z.boolean().default(true),
  employeeCreateInDimacon: z.boolean().default(false),
})

export type SyncSteps = z.infer<typeof SyncStepsSchema>

/**
 * Feldübergreifend normalisieren statt ablehnen: `employeeCreateInDimacon`
 * greift nur ZUSÄTZLICH zu `employees` — ohne den Stammdaten-Abgleich liest
 * der Lauf den Schalter ohnehin nie (run.ts startet `runEmployeeSync` nur bei
 * `steps.employees`). Bliebe er trotzdem auf `true` stehen, würde er
 * mitgespeichert, in Anzeige und Badges als aktiver Schritt gezählt und beim
 * späteren Wiedereinschalten von `employees` ungefragt wieder scharf — ein
 * Run-Body `{steps:{employees:true}}` wird eine Ebene tief über die
 * gespeicherten Defaults gemerged (Issue #17).
 *
 * LOAD-BEARING: das läuft als `.transform` NACH der Validierung. Es kann keine
 * bisher abgelehnte Eingabe retten — „ungültige gespeicherte Defaults sind
 * fail-closed" bleibt unverändert — und schaltet ausschließlich in die
 * schreibärmere Richtung ab.
 */
export function normalizeSyncSteps(steps: SyncSteps): SyncSteps {
  return steps.employees ? steps : { ...steps, employeeCreateInDimacon: false }
}

export const DEFAULT_STEPS: SyncSteps = {
  employees: true,
  customers: true,
  projects: true,
  assignments: true,
  archive: true,
  employeeCreateInDimacon: false,
}

export const SyncRunInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  dryRun: z.boolean().optional(),
  steps: SyncStepsSchema.transform(normalizeSyncSteps).optional(),
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

/**
 * Welcher Weg die Auflösungen genommen haben (Issue #15). Jede Bündelung
 * hat einen Einzelabruf-Fallback — ohne diese Anzeige wäre im Ergebnis nicht
 * erkennbar, ob die Optimierung greift. Optional, damit ältere Läufe und
 * ältere Clients unverändert lesbar bleiben.
 */
export interface SyncLookupInfo {
  jobs: "period" | "per-job"
  teamAssignments: "period" | "per-job" | "none"
  projects: "bulk" | "per-id"
  customers: "preloaded" | "bulk" | "per-id"
  clockinCustomerIndex: boolean
  clockinProjectPrefetch: "bundled" | "per-id" | "off"
  archiveHorizonDays: number
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
  /** Auflösungswege des Laufs — fehlt auf frühen Rückgabepfaden */
  lookups?: SyncLookupInfo
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
