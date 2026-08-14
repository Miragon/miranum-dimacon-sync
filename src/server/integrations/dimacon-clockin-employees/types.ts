import { z } from "zod"

export const EmployeeSyncInputSchema = z.object({
  dryRun: z.boolean().optional(),
})

export type EmployeeSyncInput = z.infer<typeof EmployeeSyncInputSchema>

export type EmployeeSyncDirection = "dimacon→clockin" | "clockin→dimacon" | "match"

export type EmployeeSyncStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped"
  | "reported"
  | "failed"

export interface EmployeeSyncRow {
  direction: EmployeeSyncDirection
  dimaconId?: string
  clockinId?: number
  name: string
  status: EmployeeSyncStatus
  reason?: string
}

export interface EmployeeSyncError {
  scope: "load" | "employee" | "mapping"
  refId?: string
  message: string
}

export interface EmployeeSyncResult {
  dryRun: boolean
  durationMs: number
  counts: { dimacon: number; clockin: number; matched: number }
  employees: EmployeeSyncRow[]
  errors: EmployeeSyncError[]
}

/** Normalisierte Sicht auf einen Clockin-Mitarbeiter (EmployeeResource) */
export interface ClockinEmployeeInfo {
  id: number
  firstName: string
  lastName: string
  personnelNumber?: string
  email?: string
  phoneWork?: string
  /** Roh-Ressource für den Mapping-Diff — nur zur Laufzeit befüllt */
  raw?: Record<string, unknown>
  customFieldValues?: { custom_field_id?: number; value?: string | null }[]
}
