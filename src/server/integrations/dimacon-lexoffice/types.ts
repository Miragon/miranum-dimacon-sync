import { z } from "zod"

export const CustomerSyncInputSchema = z.object({
  dryRun: z.boolean().optional(),
})

export type CustomerSyncInput = z.infer<typeof CustomerSyncInputSchema>

export type CustomerAlignStatus = "created" | "aligned" | "unchanged" | "failed"

export interface CustomerAlignRow {
  dimaconCustomerId: string
  name: string
  lexwareContactId?: string
  lexwareNumber?: string
  status: CustomerAlignStatus
  reason?: string
}

export interface CustomerSyncError {
  scope: "customers" | "customer"
  refId?: string
  message: string
}

export interface CustomerSyncResult {
  dryRun: boolean
  durationMs: number
  customers: CustomerAlignRow[]
  errors: CustomerSyncError[]
}
