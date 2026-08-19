import { Hono } from "hono"
import { getOrCreateDevTenant, listActiveTenants } from "../db/repos/tenants.js"
import { isAuthConfigured, type WorkOSClaims } from "../lib/auth.js"
import { getCachedTenantByOrgId } from "../lib/tenant.js"

interface MeEnv {
  Variables: { user?: WorkOSClaims }
}

/**
 * Sitzt hinter requireAuth, aber VOR resolveTenant: das Client-TenantGate
 * braucht auch für unbekannte/inaktive Orgs eine strukturierte Antwort
 * (403 + Code), nicht den Middleware-Kurzschluss.
 */
export const me = new Hono<MeEnv>().get("/", async (c) => {
  if (!isAuthConfigured()) {
    const tenant = await getOrCreateDevTenant()
    return c.json({
      userId: "dev",
      organizationId: tenant.workosOrgId,
      tenant: { id: tenant.id, name: tenant.displayName },
    })
  }

  const user = c.get("user")
  const orgId = user?.org_id
  if (!orgId) {
    return c.json(
      { error: "forbidden: no organization in token", code: "NO_ORG", organizationId: null },
      403,
    )
  }
  const tenant = await getCachedTenantByOrgId(orgId)
  if (!tenant) {
    return c.json(
      { error: "forbidden: unknown organization", code: "UNKNOWN_ORG", organizationId: orgId },
      403,
    )
  }
  if (!tenant.active) {
    return c.json(
      { error: "forbidden: organization deactivated", code: "ORG_INACTIVE", organizationId: orgId },
      403,
    )
  }
  return c.json({
    userId: user?.sub ?? "unknown",
    organizationId: orgId,
    tenant: { id: tenant.id, name: tenant.displayName },
  })
})

/**
 * Mandanten-Liste für den Switcher. `orgId` ist die WorkOS-`org_…`-Id —
 * switchToOrganization() braucht sie; die interne uuid bleibt Server-Sache.
 * Bewusst nur id+Name (Namens-Disclosure über Mandanten hinweg ist für das
 * interne Tool akzeptiert und im Plan dokumentiert).
 */
export const tenantsRoute = new Hono().get("/", async (c) => {
  const all = await listActiveTenants()
  return c.json(all.map((t) => ({ orgId: t.workosOrgId, name: t.displayName })))
})
