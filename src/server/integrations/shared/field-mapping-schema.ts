import { z } from "zod"

export const MappingEntitySchema = z.enum([
  "project",
  "customer",
  "employee",
  "lexofficeContact",
  /** Gegenrichtung: Lexware-Kontakt → neuer Dimacon-Kunde (Übernahme) */
  "dimaconCustomer",
])
export type MappingEntity = z.infer<typeof MappingEntitySchema>

/**
 * Quelle: Standardfeld des Quellsystems oder Dimacon-Custom-Attribut (per
 * Definition-ID). Quellsystem ist Dimacon — außer bei `dimaconCustomer`, dort
 * sind die Standardfelder Lexware-Felder und Attribut-Quellen gibt es nicht.
 */
export const SourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standard"), field: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("attribute"), attributeId: z.string().min(1).max(80) }),
])
export type SourceRef = z.infer<typeof SourceRefSchema>

/**
 * Ziel: Standardfeld des Zielsystems, Clockin-Custom-Field (per numerischer
 * ID) oder Dimacon-Custom-Attribut (per Definition-ID — nur `dimaconCustomer`).
 */
export const TargetRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standard"), field: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("custom"), customFieldId: z.number().int().positive() }),
  z.object({ kind: z.literal("attribute"), attributeId: z.string().min(1).max(80) }),
])
export type TargetRef = z.infer<typeof TargetRefSchema>

export const MappingRuleSchema = z.object({
  source: SourceRefSchema,
  target: TargetRefSchema,
})
export type MappingRule = z.infer<typeof MappingRuleSchema>

export const EntityFieldMappingSchema = z.object({
  version: z.literal(1).default(1),
  rules: z.array(MappingRuleSchema).max(100),
})
export type EntityFieldMapping = z.infer<typeof EntityFieldMappingSchema>

export function targetKey(t: TargetRef): string {
  if (t.kind === "standard") return `standard:${t.field}`
  if (t.kind === "custom") return `custom:${t.customFieldId}`
  return `attribute:${t.attributeId}`
}
