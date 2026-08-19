import { eq } from "drizzle-orm"
import { getDb } from "../client.js"
import { tenants } from "../schema.js"

export interface Tenant {
  id: string
  workosOrgId: string
  displayName: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

/** Fester Org-Schlüssel des Dev-Mandanten (Auth deaktiviert). */
export const DEV_TENANT_ORG_ID = "org_dev"

export async function getTenantByOrgId(orgId: string): Promise<Tenant | undefined> {
  const rows = await getDb().select().from(tenants).where(eq(tenants.workosOrgId, orgId)).limit(1)
  return rows[0]
}

export async function getTenantById(id: string): Promise<Tenant | undefined> {
  const rows = await getDb().select().from(tenants).where(eq(tenants.id, id)).limit(1)
  return rows[0]
}

export async function listActiveTenants(): Promise<Tenant[]> {
  return getDb().select().from(tenants).where(eq(tenants.active, true))
}

export async function createTenant(input: {
  workosOrgId: string
  displayName: string
}): Promise<Tenant> {
  const [row] = await getDb().insert(tenants).values(input).returning()
  return row
}

/**
 * Dev-Fallback ohne WorkOS: echte DB-Zeile statt synthetischem Objekt, damit
 * Credentials/Schedules/Mappings-FKs in Dev identisch funktionieren.
 */
export async function getOrCreateDevTenant(): Promise<Tenant> {
  const existing = await getTenantByOrgId(DEV_TENANT_ORG_ID)
  if (existing) return existing
  const [row] = await getDb()
    .insert(tenants)
    .values({ workosOrgId: DEV_TENANT_ORG_ID, displayName: "Entwicklung (lokal)" })
    .onConflictDoNothing({ target: tenants.workosOrgId })
    .returning()
  // onConflictDoNothing liefert bei Konflikt keine Zeile — dann existiert sie.
  return row ?? ((await getTenantByOrgId(DEV_TENANT_ORG_ID)) as Tenant)
}
