import { Hono } from "hono"
import type { Context } from "hono"
import { timingSafeEqual } from "node:crypto"
import { env } from "../lib/env.js"
import { log } from "../lib/log.js"
import { isRunning, SyncBusyError } from "../integrations/mutex.js"
import { getIntegration, integrations, runIntegration } from "../integrations/registry.js"
import { getNextRun, isCronActive } from "../integrations/scheduler.js"
import { isConfigured, missingEnv } from "../integrations/types.js"
import type { IntegrationDefinition } from "../integrations/types.js"

/**
 * Offene Routen (vor der Auth-Middleware gemountet): run ist per
 * SYNC_WEBHOOK_SECRET geschützt (service-to-service), healthz ist ein
 * reiner Status-Endpoint — gleiche Haltung wie das Legacy-`/api/sync`.
 */
export const integrationsOpenRoutes = new Hono()

integrationsOpenRoutes.get("/:id/healthz", (c) => {
  const def = getIntegration(c.req.param("id"))
  if (!def) return c.json({ error: "unknown integration" }, 404)
  return c.json({
    ok: true,
    integration: def.id,
    configured: isConfigured(def),
    cronActive: isCronActive(def.id),
    nextRun: getNextRun(def.id),
    running: isRunning(def.id),
  })
})

integrationsOpenRoutes.post("/:id/run", (c) => {
  const def = getIntegration(c.req.param("id"))
  if (!def) return c.json({ error: "unknown integration" }, 404)
  return handleIntegrationRun(def, c)
})

/** Authentifizierte Routen (hinter der Auth-Middleware gemountet). */
export const integrationsApiRoutes = new Hono()

integrationsApiRoutes.get("/", (c) =>
  c.json(
    integrations.map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      systems: def.systems,
      configured: isConfigured(def),
      missingEnv: missingEnv(def),
      running: isRunning(def.id),
      cronActive: isCronActive(def.id),
      nextRun: getNextRun(def.id),
    })),
  ),
)

/** Gemeinsamer Run-Handler — auch vom Legacy-`/api/sync/run` genutzt. */
export async function handleIntegrationRun(def: IntegrationDefinition, c: Context) {
  const secret = env.sync.webhookSecret()
  if (secret) {
    const provided = extractToken(c.req.header("authorization"), c.req.header("x-sync-token"))
    if (!provided || !constantTimeEqual(provided, secret)) {
      log.warn("integration run unauthorized", { integration: def.id })
      return c.json({ error: "unauthorized" }, 401)
    }
  }

  const missing = missingEnv(def)
  if (missing.length > 0) {
    return c.json({ error: "integration not configured", missing }, 503)
  }

  const raw = await safeJson(c.req.raw)
  const parsed = def.inputSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: "invalid input", details: parsed.error.flatten() }, 400)
  }

  try {
    const result = await runIntegration(def, parsed.data)
    return c.json(result)
  } catch (err) {
    if (err instanceof SyncBusyError) {
      return c.json({ error: err.message }, 409)
    }
    throw err
  }
}

async function safeJson(req: Request): Promise<unknown> {
  if (req.headers.get("content-length") === "0") return {}
  try {
    return await req.json()
  } catch {
    return {}
  }
}

function extractToken(auth?: string, xToken?: string): string | undefined {
  if (xToken) return xToken
  if (!auth) return undefined
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m?.[1]
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}
