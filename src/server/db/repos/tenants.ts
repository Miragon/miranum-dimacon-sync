import { and, eq } from "drizzle-orm"
import { getDb } from "../client.js"
import { tenants } from "../schema.js"

export interface Tenant {
  id: string
  workosOrgId: string
  displayName: string
  active: boolean
  /** 'manual' | 'workos-sync' — Sync fasst NUR eigene Zeilen an. */
  managedBy: string
  /** Wer hat deaktiviert — Sync reaktiviert nur 'workos-sync'. */
  deactivatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export const SYNC_MANAGED = "workos-sync"

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

/** Alle Mandanten — inkl. inaktiver; der Org-Sync braucht die Vollsicht. */
export async function listAllTenants(): Promise<Tenant[]> {
  return getDb().select().from(tenants)
}

/**
 * Insert für den Org-Sync: onConflictDoNothing auf workos_org_id — verliert
 * der Sync das Rennen gegen das Ops-Script, ist das kein Fehler. Liefert die
 * neue Zeile oder undefined (Konflikt = Zeile existiert, Sync lässt sie in Ruhe).
 */
export async function insertSyncTenant(input: {
  workosOrgId: string
  displayName: string
}): Promise<Tenant | undefined> {
  const [row] = await getDb()
    .insert(tenants)
    .values({ ...input, managedBy: SYNC_MANAGED })
    .onConflictDoNothing({ target: tenants.workosOrgId })
    .returning()
  return row
}

// Die drei Sync-Mutationen sind Compare-and-Swap: die Guard-Bedingungen
// stehen in der WHERE-Klausel, nicht nur im Aufrufer-Snapshot — eine
// parallele Ops-Änderung (z. B. Not-Aus zwischen Enumeration und Write)
// kann so nie überschrieben werden. true = Zeile wurde tatsächlich geändert.

export async function renameSyncTenant(id: string, displayName: string): Promise<boolean> {
  const rows = await getDb()
    .update(tenants)
    .set({ displayName })
    .where(and(eq(tenants.id, id), eq(tenants.managedBy, SYNC_MANAGED)))
    .returning({ id: tenants.id })
  return rows.length > 0
}

export async function deactivateSyncTenant(id: string): Promise<boolean> {
  const rows = await getDb()
    .update(tenants)
    .set({ active: false, deactivatedBy: SYNC_MANAGED })
    .where(and(eq(tenants.id, id), eq(tenants.managedBy, SYNC_MANAGED), eq(tenants.active, true)))
    .returning({ id: tenants.id })
  return rows.length > 0
}

/** Reaktiviert NUR eigene Deaktivierungen — der Ops-Not-Aus bleibt stehen. */
export async function reactivateSyncTenant(id: string): Promise<boolean> {
  const rows = await getDb()
    .update(tenants)
    .set({ active: true, deactivatedBy: null })
    .where(
      and(
        eq(tenants.id, id),
        eq(tenants.managedBy, SYNC_MANAGED),
        eq(tenants.active, false),
        eq(tenants.deactivatedBy, SYNC_MANAGED),
      ),
    )
    .returning({ id: tenants.id })
  return rows.length > 0
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
