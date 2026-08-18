import { z } from "zod"

/** Zuschaltbare Phasen — Teilobjekte werden durch die inneren Defaults vervollständigt. */
export const LexofficeSyncStepsSchema = z.object({
  createContacts: z.boolean().default(true),
  alignNumbers: z.boolean().default(true),
})

export type LexofficeSyncSteps = z.infer<typeof LexofficeSyncStepsSchema>

export const DEFAULT_LEXOFFICE_STEPS: LexofficeSyncSteps = {
  createContacts: true,
  alignNumbers: true,
}

export const CustomerSyncInputSchema = z.object({
  dryRun: z.boolean().optional(),
  steps: LexofficeSyncStepsSchema.optional(),
})

export type CustomerSyncInput = z.infer<typeof CustomerSyncInputSchema>

export type CustomerAlignStatus = "created" | "aligned" | "unchanged" | "skipped" | "failed"

export interface CustomerAlignRow {
  dimaconCustomerId: string
  name: string
  lexwareContactId?: string
  lexwareNumber?: string
  status: CustomerAlignStatus
  reason?: string
}

export interface CustomerSyncError {
  scope: "customers" | "customer" | "mapping"
  refId?: string
  message: string
}

export interface CustomerSyncResult {
  dryRun: boolean
  durationMs: number
  steps: LexofficeSyncSteps
  customers: CustomerAlignRow[]
  errors: CustomerSyncError[]
}
