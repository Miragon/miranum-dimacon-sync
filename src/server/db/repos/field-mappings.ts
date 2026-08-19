import { and, eq } from "drizzle-orm"
import { EntityFieldMappingSchema } from "../../integrations/shared/field-mapping-schema.js"
import type { EntityFieldMapping } from "../../integrations/shared/field-mapping-schema.js"
import { getDb } from "../client.js"
import { fieldMappings } from "../schema.js"

export async function getFieldMapping(
  tenantId: string,
  integrationId: string,
  entity: string,
): Promise<EntityFieldMapping | undefined> {
  const rows = await getDb()
    .select({ mapping: fieldMappings.mapping })
    .from(fieldMappings)
    .where(
      and(
        eq(fieldMappings.tenantId, tenantId),
        eq(fieldMappings.integrationId, integrationId),
        eq(fieldMappings.entity, entity),
      ),
    )
    .limit(1)
  if (rows.length === 0) return undefined
  return EntityFieldMappingSchema.parse(rows[0].mapping)
}

/** `null` löscht die Zuordnung (zurück auf Default). */
export async function updateFieldMapping(
  tenantId: string,
  integrationId: string,
  entity: string,
  mapping: EntityFieldMapping | null,
): Promise<void> {
  const db = getDb()
  if (mapping === null) {
    await db
      .delete(fieldMappings)
      .where(
        and(
          eq(fieldMappings.tenantId, tenantId),
          eq(fieldMappings.integrationId, integrationId),
          eq(fieldMappings.entity, entity),
        ),
      )
    return
  }
  await db
    .insert(fieldMappings)
    .values({ tenantId, integrationId, entity, mapping })
    .onConflictDoUpdate({
      target: [fieldMappings.tenantId, fieldMappings.integrationId, fieldMappings.entity],
      set: { mapping, updatedAt: new Date() },
    })
}
