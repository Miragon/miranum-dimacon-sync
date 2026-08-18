import type { EntityCatalog } from "./field-catalog.js"
import { targetKey } from "./field-mapping-schema.js"
import type { MappingRule } from "./field-mapping-schema.js"

/**
 * Pure Engine für die Feld-Zuordnung Dimacon → Clockin: wendet Regeln auf
 * Quellwerte an, koerziert Attribut-Typen auf Clockin-Datentypen und
 * diff't gemappte Felder gegen den aktuellen Clockin-Stand. Keine I/O.
 */

export type AttributeType =
  | "STRING"
  | "NUMBER"
  | "SWITCH"
  | "SELECT"
  | "MULTI_SELECT"
  | "TIME"
  | "DATE"

export interface DimaconAttributeDef {
  id: string
  label: string
  type: AttributeType
  enumDefinitionId?: string
  isActive: boolean
}

export interface EnumDef {
  id: string
  name: string
  values: { id: string; value: string; isActive: boolean }[]
}

export interface ClockinCustomFieldDef {
  id: number
  label: string
  dataType: "text" | "number" | "date"
}

export interface Discovery {
  attributes: DimaconAttributeDef[]
  enums: Map<string, EnumDef>
  customFields: ClockinCustomFieldDef[]
}

export const EMPTY_DISCOVERY: Discovery = { attributes: [], enums: new Map(), customFields: [] }

export interface SourceValues {
  standard: Record<string, string | undefined>
  attributes: Map<string, string | undefined>
}

export interface MappingWarning {
  code: "unknown_attribute" | "unknown_custom_field" | "unknown_standard" | "type_mismatch"
  ruleIndex: number
  message: string
}

export interface AppliedMapping {
  /** direkt in den Clockin-Body spreadbar */
  standardFields: Record<string, string | null>
  customFields: { custom_field_id: number; value: string }[]
  warnings: MappingWarning[]
}

export function applyMapping(
  rules: MappingRule[],
  catalog: EntityCatalog,
  discovery: Discovery,
  values: SourceValues,
): AppliedMapping {
  const standardFields: Record<string, string | null> = {}
  const customFields: { custom_field_id: number; value: string }[] = []
  const warnings: MappingWarning[] = []
  const attributesById = new Map(discovery.attributes.map((a) => [a.id, a]))
  const customById = new Map(discovery.customFields.map((c) => [c.id, c]))
  const knownStandardTargets = new Set(catalog.standardTargets.map((t) => t.field))

  rules.forEach((rule, ruleIndex) => {
    // Quelle auflösen
    let raw: string | undefined
    let sourceType: AttributeType | "TEXT" = "TEXT"
    let enumDef: EnumDef | undefined

    if (rule.source.kind === "standard") {
      if (!(rule.source.field in values.standard)) {
        warnings.push({
          code: "unknown_standard",
          ruleIndex,
          message: `unbekanntes Quellfeld ${rule.source.field}`,
        })
        return
      }
      raw = values.standard[rule.source.field]
    } else {
      const def = attributesById.get(rule.source.attributeId)
      if (!def) {
        warnings.push({
          code: "unknown_attribute",
          ruleIndex,
          message: `Dimacon-Attribut ${rule.source.attributeId} existiert nicht mehr`,
        })
        return
      }
      sourceType = def.type
      enumDef = def.enumDefinitionId ? discovery.enums.get(def.enumDefinitionId) : undefined
      raw = values.attributes.get(rule.source.attributeId)
    }

    // Ziel schreiben
    if (rule.target.kind === "standard") {
      if (!knownStandardTargets.has(rule.target.field)) {
        warnings.push({
          code: "unknown_standard",
          ruleIndex,
          message: `unbekanntes Zielfeld ${rule.target.field}`,
        })
        return
      }
      const coerced = coerceValue(sourceType, raw, "text", enumDef)
      if (coerced === undefined) {
        if (catalog.writeSemantics === "overwrite") standardFields[rule.target.field] = null
        // fillIfNonEmpty: Feld ganz weglassen
        return
      }
      standardFields[rule.target.field] = coerced
    } else {
      const def = customById.get(rule.target.customFieldId)
      if (!def) {
        warnings.push({
          code: "unknown_custom_field",
          ruleIndex,
          message: `Clockin-Custom-Field ${rule.target.customFieldId} existiert nicht mehr`,
        })
        return
      }
      const coerced = coerceValue(sourceType, raw, def.dataType, enumDef)
      if (coerced === undefined || coerced === null) {
        if (coerced === null) {
          warnings.push({
            code: "type_mismatch",
            ruleIndex,
            message: `Wert "${raw ?? ""}" passt nicht zu ${def.dataType} (${def.label})`,
          })
        }
        // Custom-Field-Werte kennen kein null — bei overwrite-Semantik leert
        // ein expliziter Leerstring das Feld, sonst wird es weggelassen.
        if (coerced === undefined && catalog.writeSemantics === "overwrite") {
          customFields.push({ custom_field_id: def.id, value: "" })
        }
        return
      }
      customFields.push({ custom_field_id: def.id, value: coerced })
    }
  })

  return { standardFields, customFields, warnings }
}

/**
 * Koerziert einen Dimacon-Rohwert auf den Clockin-Zieltyp.
 * `undefined` = keine Quelle (Feld leer lassen/überschreiben je Semantik),
 * `null` = Wert vorhanden, aber nicht konvertierbar (type_mismatch).
 */
export function coerceValue(
  sourceType: AttributeType | "TEXT",
  raw: string | undefined,
  targetDataType: "text" | "number" | "date",
  enumDef?: EnumDef,
): string | null | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined

  let text: string
  switch (sourceType) {
    case "SWITCH":
      text = trimmed === "true" || trimmed === "1" ? "true" : "false"
      break
    case "SELECT":
      text = resolveEnumValue(trimmed, enumDef)
      break
    case "MULTI_SELECT":
      text = splitMulti(trimmed)
        .map((part) => resolveEnumValue(part, enumDef))
        .join(", ")
      break
    case "DATE":
      text = trimmed.slice(0, 10)
      break
    default:
      text = trimmed
  }

  if (targetDataType === "number") {
    const normalized = text.replace(",", ".")
    return Number.isFinite(Number(normalized)) ? normalized : null
  }
  if (targetDataType === "date") {
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null
  }
  return text
}

/** Enum-Werte können als Value-ID oder bereits als Label gespeichert sein — beides tolerieren. */
function resolveEnumValue(raw: string, enumDef?: EnumDef): string {
  if (!enumDef) return raw
  const byId = enumDef.values.find((v) => v.id === raw)
  return byId ? byId.value : raw
}

function splitMulti(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // kein JSON — als Komma-Liste behandeln
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface CurrentTargetState {
  standard: Record<string, string | null | undefined>
  customFields: Map<number, string | null | undefined>
}

/** ""≡null≡undefined — verhindert Update-Thrash gegen das Rate-Limit. */
export function diffMappedFields(
  applied: AppliedMapping,
  current: CurrentTargetState,
): { changed: boolean; changes: string[] } {
  const changes: string[] = []
  for (const [field, value] of Object.entries(applied.standardFields)) {
    if (norm(value) !== norm(current.standard[field])) changes.push(field)
  }
  for (const cf of applied.customFields) {
    if (norm(cf.value) !== norm(current.customFields.get(cf.custom_field_id))) {
      changes.push(`custom:${cf.custom_field_id}`)
    }
  }
  return { changed: changes.length > 0, changes }
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim()
}

export function validateRules(
  rules: MappingRule[],
  catalog: EntityCatalog,
  discovery: Discovery,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const seenTargets = new Set<string>()
  const knownSources = new Set(catalog.standardSources.map((s) => s.field))
  const knownTargets = new Set(catalog.standardTargets.map((t) => t.field))
  const knownAttributes = new Set(discovery.attributes.map((a) => a.id))
  const knownCustomFields = new Set(discovery.customFields.map((c) => c.id))
  const lockedTargets = new Set(catalog.lockedTargetFields)

  rules.forEach((rule, i) => {
    const tKey = targetKey(rule.target)
    if (seenTargets.has(tKey)) errors.push(`Regel ${i + 1}: Ziel ${tKey} ist doppelt belegt`)
    seenTargets.add(tKey)

    if (rule.source.kind === "standard" && !knownSources.has(rule.source.field)) {
      errors.push(`Regel ${i + 1}: unbekanntes Quellfeld "${rule.source.field}"`)
    }
    if (rule.source.kind === "attribute" && !knownAttributes.has(rule.source.attributeId)) {
      errors.push(`Regel ${i + 1}: unbekanntes Dimacon-Attribut "${rule.source.attributeId}"`)
    }
    if (rule.target.kind === "standard") {
      if (lockedTargets.has(rule.target.field)) {
        errors.push(`Regel ${i + 1}: Zielfeld "${rule.target.field}" ist fixiert (match-key)`)
      } else if (!knownTargets.has(rule.target.field)) {
        errors.push(`Regel ${i + 1}: unbekanntes Zielfeld "${rule.target.field}"`)
      }
    }
    if (rule.target.kind === "custom" && !knownCustomFields.has(rule.target.customFieldId)) {
      errors.push(
        knownCustomFields.size === 0
          ? `Regel ${i + 1}: Custom-Ziele werden für diese Entität nicht unterstützt oder es sind keine Custom-Felder definiert`
          : `Regel ${i + 1}: unbekanntes Clockin-Custom-Field ${rule.target.customFieldId}`,
      )
    }
  })

  for (const required of catalog.requiredTargets) {
    if (!seenTargets.has(`standard:${required}`)) {
      errors.push(`Pflicht-Ziel "${required}" hat keine Regel`)
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
