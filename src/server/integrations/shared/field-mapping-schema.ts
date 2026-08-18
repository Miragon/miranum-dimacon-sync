import { z } from "zod"

export const MappingEntitySchema = z.enum(["project", "customer", "employee", "lexofficeContact"])
export type MappingEntity = z.infer<typeof MappingEntitySchema>

/** Quelle: Dimacon-Standardfeld oder Custom-Attribut (per Definition-ID) */
export const SourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standard"), field: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("attribute"), attributeId: z.string().min(1).max(80) }),
])
export type SourceRef = z.infer<typeof SourceRefSchema>

/** Ziel: Clockin-Standardfeld oder Custom-Field (per numerischer ID) */
export const TargetRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standard"), field: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("custom"), customFieldId: z.number().int().positive() }),
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
  return t.kind === "standard" ? `standard:${t.field}` : `custom:${t.customFieldId}`
}
