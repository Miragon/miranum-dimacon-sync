import { createMiddleware } from "hono/factory"
import { getOrCreateDevTenant, getTenantByOrgId } from "../db/repos/tenants.js"
import type { Tenant } from "../db/repos/tenants.js"
import { isAuthConfigured, type WorkOSClaims } from "./auth.js"
import { log } from "./log.js"

export type { Tenant }

/** Hono-Env aller tenant-gescopten Routen. */
export interface AppEnv {
  Variables: {
    user?: WorkOSClaims
    tenant: Tenant
  }
}

/** Einheitliches Code-Set — das Client-Gate matcht exakt auf diese Werte. */
export type TenantErrorCode = "NO_ORG" | "UNKNOWN_ORG" | "ORG_INACTIVE"

const CACHE_TTL_MS = 30_000

const cache = new Map<string, { tenant: Tenant; at: number }>()

export async function getCachedTenantByOrgId(orgId: string): Promise<Tenant | undefined> {
  const hit = cache.get(orgId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tenant
  const tenant = await getTenantByOrgId(orgId)
  if (tenant) cache.set(orgId, { tenant, at: Date.now() })
  else cache.delete(orgId)
  return tenant
}

/** Aus Tenant-Mutationen aufrufen (Deaktivierung etc.) — ohne Arg: alles. */
export function invalidateTenantCache(orgId?: string): void {
  if (orgId === undefined) cache.clear()
  else cache.delete(orgId)
}

/**
 * Mandanten-Auflösung NACH requireAuth: org_id-Claim → tenants-Zeile.
 * Die Tabelle ist die Zugangs-Allowlist (ersetzt WORKOS_REQUIRED_ORG_ID);
 * unbekannte/inaktive Orgs enden hier mit 403 + maschinenlesbarem Code.
 */
export const resolveTenant = createMiddleware<AppEnv>(async (c, next) => {
  if (!isAuthConfigured()) {
    // Dev-Fallback: echte DB-Zeile, damit FKs (Credentials etc.) funktionieren.
    c.set("tenant", await getOrCreateDevTenant())
    return next()
  }

  const orgId = c.get("user")?.org_id
  if (!orgId) {
    return c.json({ error: "forbidden: no organization in token", code: "NO_ORG" }, 403)
  }
  const tenant = await getCachedTenantByOrgId(orgId)
  if (!tenant) {
    log.warn("tenant unknown", { orgId })
    return c.json({ error: "forbidden: unknown organization", code: "UNKNOWN_ORG" }, 403)
  }
  if (!tenant.active) {
    return c.json({ error: "forbidden: organization deactivated", code: "ORG_INACTIVE" }, 403)
  }
  c.set("tenant", tenant)
  return next()
})
