import { z } from "zod"

/** Zuschaltbare Phasen — Teilobjekte werden durch die inneren Defaults vervollständigt. */
export const SevdeskSyncStepsSchema = z.object({
  createContacts: z.boolean().default(true),
  alignNumbers: z.boolean().default(true),
})

export type SevdeskSyncSteps = z.infer<typeof SevdeskSyncStepsSchema>

export const DEFAULT_SEVDESK_STEPS: SevdeskSyncSteps = {
  createContacts: true,
  alignNumbers: true,
}

export const CustomerSyncInputSchema = z.object({
  dryRun: z.boolean().optional(),
  steps: SevdeskSyncStepsSchema.optional(),
})

export type CustomerSyncInput = z.infer<typeof CustomerSyncInputSchema>

export type CustomerAlignStatus =
  | "created"
  | "aligned"
  | "unchanged"
  | "ambiguous"
  | "conflict"
  | "skipped"
  | "failed"

export interface CustomerAlignRow {
  dimaconCustomerId: string
  name: string
  sevdeskContactId?: string
  sevdeskNumber?: string
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
  steps: SevdeskSyncSteps
  customers: CustomerAlignRow[]
  errors: CustomerSyncError[]
}
