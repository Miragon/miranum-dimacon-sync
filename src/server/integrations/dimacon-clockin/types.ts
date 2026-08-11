import { z } from "zod"

export const SyncRunInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  dryRun: z.boolean().optional(),
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
  scope: "appointments" | "enrichment" | "customer" | "employee" | "project" | "archive"
  refId?: string
  message: string
}

export interface SyncResult {
  date: string
  dryRun: boolean
  durationMs: number
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
