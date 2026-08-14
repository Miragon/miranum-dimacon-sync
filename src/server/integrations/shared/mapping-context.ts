import { sdk as clockin } from "@miragon/client-clockin"
import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import { withRetry } from "../../lib/concurrency.js"
import { getFieldMapping } from "../../lib/settings.js"
import { FIELD_CATALOG } from "./field-catalog.js"
import type { EntityCatalog } from "./field-catalog.js"
import { EMPTY_DISCOVERY } from "./field-mapping.js"
import type {
  AttributeType,
  ClockinCustomFieldDef,
  DimaconAttributeDef,
  Discovery,
  EnumDef,
} from "./field-mapping.js"
import type { MappingEntity, MappingRule } from "./field-mapping-schema.js"

export interface EntityMappingContext {
  entity: MappingEntity
  rules: MappingRule[]
  catalog: EntityCatalog
  discovery: Discovery
  /** true = persistierte Regeln aktiv (Discovery wurde geladen) */
  isCustomized: boolean
  /** true = Regeln referenzieren Custom-Fields → Reads brauchen include=customFields */
  hasCustomTargets: boolean
}

export type MappingContext = Map<MappingEntity, EntityMappingContext>

interface DimaconAttributeRow {
  id: string
  label: string
  type: AttributeType
  enumDefinitionId?: string
  isActive: boolean
}

interface DimaconEnumRow {
  id: string
  name: string
  values: { id: string; value: string; isActive: boolean }[]
}

interface ClockinCustomFieldRow {
  id?: number
  label?: string
  data_type?: "text" | "number" | "date"
}

/**
 * Lädt Regeln + Discovery pro Entity. Ohne persistierte Zuordnung werden
 * KEINE zusätzlichen API-Calls gemacht — die Defaults referenzieren nur
 * Standardfelder, das Verhalten bleibt identisch zum bisherigen Sync.
 *
 * `getClockinClient` ist ein Lazy-Getter: er wird nur für Entities mit
 * Clockin-Custom-Feldern aufgerufen (dimacon-lexoffice hat keine
 * Clockin-Credentials — eine eager-Konstruktion würde dort werfen).
 */
export async function loadMappingContext(
  dimaconClient: DimaconClient,
  getClockinClient: () => ClockInClient,
  integrationId: string,
  entities: MappingEntity[],
): Promise<MappingContext> {
  const context: MappingContext = new Map()

  for (const entity of entities) {
    const catalog = FIELD_CATALOG[entity]
    const persisted = await getFieldMapping(integrationId, entity)

    if (!persisted) {
      context.set(entity, {
        entity,
        rules: catalog.defaultRules,
        catalog,
        discovery: EMPTY_DISCOVERY,
        isCustomized: false,
        hasCustomTargets: false,
      })
      continue
    }

    // Discovery nur, wenn Regeln Attribute/Custom-Felder referenzieren —
    // reine Standard-Regeln brauchen keine Live-Definitionen.
    const needsDiscovery = persisted.rules.some(
      (r) => r.source.kind === "attribute" || r.target.kind === "custom",
    )
    const discovery = needsDiscovery
      ? await loadDiscovery(dimaconClient, getClockinClient, entity, persisted.rules)
      : EMPTY_DISCOVERY
    context.set(entity, {
      entity,
      rules: persisted.rules,
      catalog,
      discovery,
      isCustomized: true,
      hasCustomTargets: persisted.rules.some((r) => r.target.kind === "custom"),
    })
  }

  return context
}

/** Volle Discovery für den Editor (unabhängig von persistierten Regeln). */
export async function loadDiscovery(
  dimaconClient: DimaconClient,
  getClockinClient: () => ClockInClient,
  entity: MappingEntity,
  rules?: MappingRule[],
): Promise<Discovery> {
  const needsEnums = (attributes: DimaconAttributeDef[]): boolean =>
    attributes.some((a) => a.type === "SELECT" || a.type === "MULTI_SELECT")

  const attributes = await loadAttributes(dimaconClient, entity)
  const referencedOnly = rules
    ? attributes.filter(
        (a) =>
          a.isActive ||
          rules.some((r) => r.source.kind === "attribute" && r.source.attributeId === a.id),
      )
    : attributes

  const enums =
    needsEnums(referencedOnly) && referencedOnly.length > 0
      ? await loadEnums(dimaconClient)
      : new Map<string, EnumDef>()

  const customFields = await loadCustomFields(getClockinClient, entity)

  return { attributes: referencedOnly, enums, customFields }
}

async function loadAttributes(
  client: DimaconClient,
  entity: MappingEntity,
): Promise<DimaconAttributeDef[]> {
  // Dimacon kennt keine Mitarbeiter-Attribute
  if (entity === "employee") return []

  const rows = (await withRetry(() =>
    entity === "project"
      ? dimacon.getAllAttributes({ client })
      : // customer + lexofficeContact: beide lesen die Kunden-Attribute
        dimacon.getAllAttributes2({ client }),
  )) as unknown as DimaconAttributeRow[]

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    type: r.type,
    enumDefinitionId: r.enumDefinitionId,
    isActive: r.isActive,
  }))
}

async function loadEnums(client: DimaconClient): Promise<Map<string, EnumDef>> {
  const rows = (await withRetry(() =>
    dimacon.getAllEnums1({ client }),
  )) as unknown as DimaconEnumRow[]
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, values: r.values ?? [] }]))
}

async function loadCustomFields(
  getClient: () => ClockInClient,
  entity: MappingEntity,
): Promise<ClockinCustomFieldDef[]> {
  // Lexware Office kennt keine Custom-Felder — und braucht keinen Clockin-Client
  if (entity === "lexofficeContact") return []

  const client = getClient()
  const response = (await withRetry(() => {
    if (entity === "project") return clockin.getProjectCustomFields({ client })
    if (entity === "customer") return clockin.getCustomerCustomFields({ client })
    return clockin.getEmployeeCustomFields({ client })
  })) as unknown as { data?: ClockinCustomFieldRow[] }

  return (response.data ?? [])
    .filter((r): r is ClockinCustomFieldRow & { id: number } => r.id !== undefined)
    .map((r) => ({
      id: r.id,
      label: r.label ?? `Custom-Field ${r.id}`,
      dataType: r.data_type ?? "text",
    }))
}
