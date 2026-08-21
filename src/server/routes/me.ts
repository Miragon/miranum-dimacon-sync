import { Hono } from "hono"
import { getOrCreateDevTenant, listActiveTenants } from "../db/repos/tenants.js"
import { isAuthConfigured, type WorkOSClaims } from "../lib/auth.js"
import { getCachedTenantByOrgId, type AppEnv } from "../lib/tenant.js"
import { listUserOrgIds } from "../lib/workos.js"

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
 * Gefiltert nach den tatsächlichen Org-Mitgliedschaften des Callers (WorkOS
 * User-Management-API via WORKOS_API_KEY, lib/workos.ts). Ohne Key, im
 * Dev-Modus (kein user-Claim) oder bei API-Fehlern: nur der aktive Mandant —
 * fail-closed gegenüber fremden Mandanten-Namen, nie 5xx (die Switcher-Liste
 * ist für das Client-TenantGate optional).
 */
export const tenantsRoute = new Hono<AppEnv>().get("/", async (c) => {
  // Von resolveTenant garantiert — Mount-Reihenfolge in app.ts ist load-bearing.
  const own = c.get("tenant")
  const ownEntry = { orgId: own.workosOrgId, name: own.displayName }

  const userId = c.get("user")?.sub
  const memberOrgIds = userId ? await listUserOrgIds(userId) : undefined
  if (!memberOrgIds) return c.json([ownEntry])

  const all = await listActiveTenants()
  return c.json(
    all
      // Eigener Mandant immer dabei — deckt Lag der Membership-API ab.
      .filter((t) => memberOrgIds.has(t.workosOrgId) || t.workosOrgId === own.workosOrgId)
      .map((t) => ({ orgId: t.workosOrgId, name: t.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )
})
