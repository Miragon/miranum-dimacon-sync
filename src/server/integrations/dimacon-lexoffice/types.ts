import { z } from "zod"

export const CustomerSyncInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
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
  scope: "appointments" | "jobs" | "customers" | "customer"
  refId?: string
  message: string
}

export interface CustomerSyncResult {
  date: string
  dryRun: boolean
  durationMs: number
  customers: CustomerAlignRow[]
  errors: CustomerSyncError[]
}
