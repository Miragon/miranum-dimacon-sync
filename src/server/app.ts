import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { readFile } from "node:fs/promises"
import clockin from "./routes/clockin.js"
import credentials from "./routes/credentials.js"
import dimacon from "./routes/dimacon.js"
import lexoffice from "./routes/lexoffice.js"
import mappings from "./routes/mappings.js"
import { me, tenantsRoute } from "./routes/me.js"
import settings from "./routes/settings.js"
import sync from "./routes/sync.js"
import systems from "./routes/systems.js"
import { integrationsApiRoutes, integrationsOpenRoutes } from "./routes/integrations.js"
import { isAuthConfigured, requireAuth } from "./lib/auth.js"
import { resolveTenant } from "./lib/tenant.js"
import { formatError } from "./lib/errors.js"
import { log } from "./lib/log.js"
import type { AppEnv } from "./lib/tenant.js"

/**
 * Baut die Hono-App (ohne Server-Start) — separat vom Bootstrap in index.ts,
 * damit Tests die App inklusive Mount-Reihenfolge direkt fahren können.
 */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get("/healthz", (c) => c.json({ ok: true }))

  // Vor der Auth-Middleware gemountet (Reihenfolge ist load-bearing):
  // run-Endpoints sind Dual-Auth (Mandanten-Webhook-Secret ODER AuthKit-JWT),
  // healthz liefert unauthentifiziert nur Liveness.
  app.route("/api/sync", sync)
  app.route("/api/integrations", integrationsOpenRoutes)

  app.use("/api/*", requireAuth)

  // /api/me sitzt hinter requireAuth, aber VOR resolveTenant: das Client-
  // TenantGate braucht auch für unbekannte Orgs die strukturierte 403-Antwort.
  app.route("/api/me", me)

  app.use("/api/*", resolveTenant)

  app.route("/api/tenants", tenantsRoute)
  app.route("/api/integrations", integrationsApiRoutes)
  app.route("/api/systems", systems)
  app.route("/api/clockin", clockin)
  app.route("/api/dimacon", dimacon)
  app.route("/api/lexoffice", lexoffice)
  app.route("/api/settings", settings)
  app.route("/api/mappings", mappings)
  app.route("/api/credentials", credentials)

  if (isAuthConfigured()) {
    log.info("auth enabled", { tenantSource: "tenants table (org_id claim)" })
  } else {
    log.warn("auth disabled — WORKOS_CLIENT_ID not set, /api/* is unprotected (dev tenant)")
  }

  app.onError((err, c) => {
    // Sanitisiert: err.message kann pg-/Crypto-/Upstream-Interna tragen und
    // erreicht auch unauthentifizierte Webhook-Caller. Details nur ins Log;
    // erwartbare Fälle (503/409/400) sind in den Routen typisiert gemappt.
    log.error("unhandled error", { path: c.req.path, error: formatError(err) })
    return c.json({ error: "internal error" }, 500)
  })

  if (process.env.NODE_ENV === "production") {
    app.use("/*", serveStatic({ root: "./dist/client" }))
    app.get("/*", async (c) => {
      const html = await readFile("./dist/client/index.html", "utf-8")
      return c.html(html)
    })
  }

  return app
}
