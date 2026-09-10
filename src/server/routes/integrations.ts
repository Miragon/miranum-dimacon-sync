import { Hono } from "hono"
import type { Context } from "hono"
import { CredentialCryptoError } from "../lib/crypto.js"
import { AUTH_UNAVAILABLE_MESSAGE, isAuthConfigured, verifyAccessToken } from "../lib/auth.js"
import { safeJson } from "../lib/http.js"
import { log } from "../lib/log.js"
import { getCachedTenantByOrgId, type AppEnv } from "../lib/tenant.js"
import { getRunDefaults } from "../db/repos/schedules.js"
import { getOrCreateDevTenant, type Tenant } from "../db/repos/tenants.js"
import { findTenantBySecret, touchLastUsed } from "../db/repos/webhook-secrets.js"
import { listRuns, type RunTrigger } from "../db/repos/sync-runs.js"
import { buildRunContext } from "../integrations/context.js"
import { isRunning, SyncBusyError } from "../integrations/mutex.js"
import { MAPPABLE_ENTITIES } from "../integrations/shared/field-catalog.js"
import { getIntegration, integrations, runIntegration } from "../integrations/registry.js"
import { resolveRunInput } from "../integrations/run-input.js"
import { getNextRun, isCronActive } from "../integrations/scheduler.js"
import { isConfigured, missingCredentials } from "../integrations/types.js"
import type { IntegrationDefinition } from "../integrations/types.js"

/**
 * Offene Routen (vor der Auth-Middleware gemountet). Der run-Endpoint ist
 * Dual-Auth: ein Mandanten-Webhook-Secret (x-sync-token oder Bearer)
 * identifiziert den Mandanten direkt; alternativ zählt ein gültiges
 * AuthKit-JWT (der UI-Pfad — vorher scheiterte der am Secret-Vergleich).
 * Fail-closed: ohne identifizierbaren Mandanten 401, kein impliziter
 * Default-Mandant. Bei GÜLTIGEM JWT mit unbekannter/fehlender Org ist es
 * dagegen ein 403 mit Code (NO_ORG/UNKNOWN_ORG/ORG_INACTIVE) — ein
 * Re-Login würde daran nichts ändern.
 */
export const integrationsOpenRoutes = new Hono()

integrationsOpenRoutes.get("/:id/healthz", async (c) => {
  const def = getIntegration(c.req.param("id"))
  if (!def) return c.json({ error: "unknown integration" }, 404)

  const tenant = await tenantForStatus(c)
  if (!tenant) {
    // Ohne (gültiges) Secret nur Liveness — configured/nextRun/running sind
    // Mandanten-Daten und gehören nicht unauthentifiziert ins Netz.
    return c.json({ ok: true, integration: def.id })
  }
  return c.json({
    ok: true,
    integration: def.id,
    configured: await isConfigured(def, tenant.id),
    cronActive: isCronActive(tenant.id, def.id),
    nextRun: getNextRun(tenant.id, def.id),
    running: isRunning(tenant.id, def.id),
  })
})

integrationsOpenRoutes.post("/:id/run", (c) => {
  const def = getIntegration(c.req.param("id"))
  if (!def) return c.json({ error: "unknown integration" }, 404)
  return handleIntegrationRun(def, c)
})

/** Authentifizierte Routen (hinter requireAuth + resolveTenant gemountet). */
export const integrationsApiRoutes = new Hono<AppEnv>()

integrationsApiRoutes.get("/", async (c) => {
  const tenant = c.get("tenant")
  const rows = await Promise.all(
    integrations.map(async (def) => {
      const missing = await missingCredentials(def, tenant.id)
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        systems: def.systems,
        configured: missing.length === 0,
        missingCredentials: missing,
        running: isRunning(tenant.id, def.id),
        cronActive: isCronActive(tenant.id, def.id),
        nextRun: getNextRun(tenant.id, def.id),
        // Single Source of Truth für den „Erweitert"-Link im Client
        mappable: def.id in MAPPABLE_ENTITIES,
        // Gespeicherter Run-Umfang — belegt das manuelle Formular vor.
        runDefaults: await getRunDefaults(tenant.id, def.id),
      }
    }),
  )
  return c.json(rows)
})

/**
 * Run-Historie einer Integration (neueste zuerst). Bewusst auf dem
 * AUTHENTIFIZIERTEN Router: Läufe sind Mandantendaten — `listRuns` selektiert
 * zusätzlich tenant-gescopt.
 */
integrationsApiRoutes.get("/:id/runs", async (c) => {
  const def = getIntegration(c.req.param("id"))
  if (!def) return c.json({ error: "unknown integration" }, 404)
  const raw = Number(c.req.query("limit"))
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 50) : 20
  return c.json(await listRuns(c.get("tenant").id, def.id, limit))
})

/**
 * Für Status-Endpoints: Mandant nur bei gültigem Webhook-Secret (oder Dev).
 * Deaktivierte Mandanten liefern nur Liveness — findTenantBySecret filtert
 * `active` bereits im SQL.
 */
export async function tenantForStatus(c: Context): Promise<Tenant | undefined> {
  const token = extractToken(c.req.header("authorization"), c.req.header("x-sync-token"))
  if (token) return findTenantBySecret(token)
  if (!isAuthConfigured() && process.env.NODE_ENV !== "production") {
    return getOrCreateDevTenant()
  }
  return undefined
}

/** Gemeinsamer Run-Handler — auch vom Legacy-`/api/sync/run` genutzt. */
export async function handleIntegrationRun(def: IntegrationDefinition, c: Context) {
  const xToken = c.req.header("x-sync-token")
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  const token = xToken ?? bearer

  let tenant: Tenant | undefined
  let trigger: RunTrigger = "webhook"

  if (token) {
    tenant = await findTenantBySecret(token)
    if (tenant) {
      touchLastUsed(tenant.id)
    } else if (bearer && !xToken) {
      // Kein Secret-Treffer, aber ein Bearer-Header: AuthKit-JWT prüfen —
      // der UI-Pfad. x-sync-token ist dagegen explizit ein Webhook-Secret,
      // für das es keinen JWT-Fallback gibt.
      const result = await verifyAccessToken(bearer)
      if (result.status === "unavailable") {
        // JWKS-Ausfall darf keinen Re-Login provozieren.
        return c.json({ error: AUTH_UNAVAILABLE_MESSAGE, code: "AUTH_UNAVAILABLE" }, 503)
      }
      if (result.status === "valid") {
        // Ab hier ist der Aufrufer identifiziert — fachlich dieselben
        // 403-Fälle wie in resolveTenant, damit der Client im TenantGate
        // landet statt im Login-Flow.
        const orgId = result.claims.org_id
        if (!orgId) {
          return c.json({ error: "forbidden: no organization in token", code: "NO_ORG" }, 403)
        }
        tenant = await getCachedTenantByOrgId(orgId)
        if (!tenant) {
          log.warn("tenant unknown", { orgId })
          return c.json({ error: "forbidden: unknown organization", code: "UNKNOWN_ORG" }, 403)
        }
        trigger = "manual"
      }
      // `invalid` fällt durch auf das 401 unten — fail-closed für Caller
      // ohne Secret-Treffer.
    }
  } else if (!isAuthConfigured() && process.env.NODE_ENV !== "production") {
    // Dev ohne Auth bleibt offen (heutige Haltung) — Prod ist durch den
    // Boot-Guard (WORKOS_CLIENT_ID Pflicht) nie in diesem Zweig.
    tenant = await getOrCreateDevTenant()
    trigger = "manual"
  }

  if (!tenant) {
    log.warn("integration run unauthorized", { integration: def.id })
    return c.json({ error: "unauthorized" }, 401)
  }
  if (!tenant.active) {
    return c.json({ error: "forbidden: organization deactivated", code: "ORG_INACTIVE" }, 403)
  }

  const missing = await missingCredentials(def, tenant.id)
  if (missing.length > 0) {
    return c.json({ error: "integration not configured", missing }, 503)
  }

  // Request-Body ÜBER den gespeicherten Umfang legen: ohne Body gilt der
  // gespeicherte Umfang (leer = alles an, wie bisher), Abweichungen im Body
  // gelten nur für diesen Lauf. Reihenfolge (Auth → active →
  // missingCredentials → Input) bleibt unverändert.
  const resolved = await resolveRunInput(def, tenant.id, await safeJson(c.req.raw))
  if (!resolved.ok) {
    return c.json({ error: resolved.error, details: resolved.details }, 400)
  }

  try {
    const result = await runIntegration(def, buildRunContext(def, tenant, trigger), resolved.input)
    return c.json(result)
  } catch (err) {
    if (err instanceof SyncBusyError) {
      return c.json({ error: err.message }, 409)
    }
    if (err instanceof CredentialCryptoError) {
      // Bewusst NICHT als „not configured" maskiert: Operator soll einen
      // Schlüssel-/Rotationsfehler erkennen, nicht Tokens neu eintippen.
      log.error("credential decryption failed", {
        tenant: tenant.id,
        integration: def.id,
        kind: err.kind,
        keyId: err.keyId,
      })
      return c.json(
        {
          error:
            "Zugangsdaten können nicht entschlüsselt werden (Schlüssel wurde gewechselt?) — " +
            "Token in den Einstellungen neu speichern behebt das",
        },
        500,
      )
    }
    throw err
  }
}

function extractToken(auth?: string, xToken?: string): string | undefined {
  if (xToken) return xToken
  if (!auth) return undefined
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m?.[1]
}
