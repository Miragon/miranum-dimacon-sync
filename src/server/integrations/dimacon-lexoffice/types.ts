import { z } from "zod"

/** Zuschaltbare Phasen — Teilobjekte werden durch die inneren Defaults vervollständigt. */
export const LexofficeSyncStepsSchema = z.object({
  createContacts: z.boolean().default(true),
  alignNumbers: z.boolean().default(true),
  /**
   * Gegenrichtung Lexware → Dimacon: Kunden mit aktuellem Angebot bzw.
   * Auftragsbestätigung in Dimacon anlegen. Opt-in — per Default AUS, ein
   * fehlender Key darf nie zu „an" werden (gleiche Regel wie
   * `employeeCreateInDimacon`, Issue #17).
   */
  importFromLexware: z.boolean().default(false),
})

export type LexofficeSyncSteps = z.infer<typeof LexofficeSyncStepsSchema>

export const DEFAULT_LEXOFFICE_STEPS: LexofficeSyncSteps = {
  createContacts: true,
  alignNumbers: true,
  importFromLexware: false,
}

export const CustomerSyncInputSchema = z.object({
  dryRun: z.boolean().optional(),
  steps: LexofficeSyncStepsSchema.optional(),
})

export type CustomerSyncInput = z.infer<typeof CustomerSyncInputSchema>

/**
 * `ambiguous` (mehrere gleichwertige Kandidaten) und `conflict` (die
 * Nummernstufe ist unbrauchbar — Nummer trifft einen fremden Kontakt oder die
 * Nummernsuche ist ausgefallen) sind garantiert schreibfrei: weder
 * Kontakt-Anlage noch Rückschreiben der Kundennummer nach Dimacon.
 */
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
  lexwareContactId?: string
  lexwareNumber?: string
  status: CustomerAlignStatus
  reason?: string
}

/**
 * Ergebnis der Übernahme Lexware → Dimacon. Bereits verknüpfte Kontakte
 * erzeugen KEINE Zeile — ihr Stand steht in `customers`. `skipped` ist
 * schreibfrei und trägt immer eine Begründung.
 */
export type CustomerImportStatus = "created" | "skipped" | "failed"

export interface CustomerImportRow {
  lexwareContactId: string
  lexwareNumber?: string
  name: string
  /** Belegnummern (Angebot/Auftragsbestätigung), über die der Kontakt Kandidat wurde */
  vouchers: string[]
  dimaconCustomerId?: string
  status: CustomerImportStatus
  reason?: string
}

export interface CustomerSyncError {
  scope: "customers" | "customer" | "mapping" | "import"
  refId?: string
  message: string
}

export interface CustomerSyncResult {
  dryRun: boolean
  durationMs: number
  steps: LexofficeSyncSteps
  customers: CustomerAlignRow[]
  imports: CustomerImportRow[]
  errors: CustomerSyncError[]
}
