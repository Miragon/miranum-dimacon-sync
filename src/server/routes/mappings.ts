import { Hono } from "hono"
import { z } from "zod"
import { getClockInClient, getDimaconClient } from "../lib/clients.js"
import { formatError } from "../lib/errors.js"
import { safeJson } from "../lib/http.js"
import { log } from "../lib/log.js"
import { getFieldMapping, updateFieldMapping } from "../lib/settings.js"
import { FIELD_CATALOG, MAPPABLE_ENTITIES } from "../integrations/shared/field-catalog.js"
import { validateRules } from "../integrations/shared/field-mapping.js"
import type { Discovery } from "../integrations/shared/field-mapping.js"
import { MappingRuleSchema } from "../integrations/shared/field-mapping-schema.js"
import type { MappingEntity } from "../integrations/shared/field-mapping-schema.js"
import { loadDiscovery } from "../integrations/shared/mapping-context.js"

const app = new Hono()

const PutBodySchema = z.object({
  rules: z.array(MappingRuleSchema).max(100),
})

/** Editor-Ansicht: Katalog + Live-Discovery + gespeicherte Regeln pro Entity. */
app.get("/:integrationId", async (c) => {
  const integrationId = c.req.param("integrationId")
  const entities = MAPPABLE_ENTITIES[integrationId]
  if (!entities) return c.json({ error: "integration has no field mapping" }, 404)

  const blocks = await Promise.all(entities.map((entity) => entityBlock(integrationId, entity)))
  return c.json({ integrationId, entities: blocks })
})

app.put("/:integrationId/:entity", async (c) => {
  const integrationId = c.req.param("integrationId")
  const entity = c.req.param("entity") as MappingEntity
  const entities = MAPPABLE_ENTITIES[integrationId]
  if (!entities || !entities.includes(entity)) {
    return c.json({ error: "unknown integration or entity" }, 404)
  }

  const raw = await safeJson(c.req.raw)
  const parsed = PutBodySchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: "invalid input", details: parsed.error.flatten() }, 400)
  }

  const catalog = FIELD_CATALOG[entity]
  const attempt = await tryDiscovery(entity)

  // Ohne Discovery lassen sich nur Standard-Regeln verifizieren — Regeln mit
  // Attribut-/Custom-Referenzen brauchen die Live-Definitionen zwingend.
  const needsDiscovery = parsed.data.rules.some(
    (r) => r.source.kind === "attribute" || r.target.kind === "custom",
  )
  if (!attempt.ok && needsDiscovery) {
    return c.json({ error: `Discovery fehlgeschlagen: ${attempt.message}` }, 502)
  }
  const discovery: Discovery = attempt.ok
    ? attempt.value
    : { attributes: [], enums: new Map(), customFields: [] }

  const validation = validateRules(parsed.data.rules, catalog, discovery)
  if (!validation.ok) {
    return c.json({ error: "invalid mapping", details: validation.errors }, 400)
  }

  await updateFieldMapping(integrationId, entity, { version: 1, rules: parsed.data.rules })
  log.info("field mapping updated", { integrationId, entity, rules: parsed.data.rules.length })
  return c.json(await entityBlock(integrationId, entity))
})

app.delete("/:integrationId/:entity", async (c) => {
  const integrationId = c.req.param("integrationId")
  const entity = c.req.param("entity") as MappingEntity
  const entities = MAPPABLE_ENTITIES[integrationId]
  if (!entities || !entities.includes(entity)) {
    return c.json({ error: "unknown integration or entity" }, 404)
  }

  await updateFieldMapping(integrationId, entity, null)
  log.info("field mapping reset to default", { integrationId, entity })
  return c.json(await entityBlock(integrationId, entity))
})

export default app

async function entityBlock(integrationId: string, entity: MappingEntity) {
  const catalog = FIELD_CATALOG[entity]
  const persisted = await getFieldMapping(integrationId, entity)
  const rules = persisted?.rules ?? catalog.defaultRules

  const discoveryErrors: string[] = []
  let discovery: Discovery = { attributes: [], enums: new Map(), customFields: [] }
  const attempt = await tryDiscovery(entity)
  if (attempt.ok) discovery = attempt.value
  else discoveryErrors.push(attempt.message)

  // Editor braucht Enum-Labels nur zur Anzeige; Regeln gegen die Discovery
  // prüfen, damit veraltete Referenzen als Warnung sichtbar werden.
  const validation = attempt.ok ? validateRules(rules, catalog, discovery) : { ok: true as const }

  return {
    entity,
    isDefault: persisted === undefined,
    rules,
    locked: catalog.lockedPairs,
    requiredTargets: catalog.requiredTargets,
    writeSemantics: catalog.writeSemantics,
    sources: {
      standard: catalog.standardSources,
      attributes: discovery.attributes.map((a) => ({
        id: a.id,
        label: a.label,
        type: a.type,
        isActive: a.isActive,
      })),
    },
    targets: {
      standard: catalog.standardTargets,
      custom: discovery.customFields,
    },
    warnings: validation.ok ? [] : validation.errors,
    discoveryErrors,
  }
}

async function tryDiscovery(
  entity: MappingEntity,
): Promise<{ ok: true; value: Discovery } | { ok: false; message: string }> {
  try {
    // Clockin-Client lazy: dimacon-lexoffice hat keine Clockin-Credentials
    const value = await loadDiscovery(getDimaconClient(), getClockInClient, entity)
    return { ok: true, value }
  } catch (err) {
    return { ok: false, message: formatError(err) }
  }
}
