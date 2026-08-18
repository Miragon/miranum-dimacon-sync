import "dotenv/config"

import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { env } from "./lib/env.js"
import { formatError } from "./lib/errors.js"
import { log } from "./lib/log.js"
import { startScheduler } from "./integrations/scheduler.js"

/**
 * Produktions-Guard: die App darf nie unauthentifiziert betrieben werden.
 * Im Dev bleibt der offene Fallback (Warnung beim Boot) erhalten.
 */
function assertProductionAuthConfig(): void {
  if (process.env.NODE_ENV !== "production") return

  const missing: string[] = []
  if (!env.workos.clientId()) missing.push("WORKOS_CLIENT_ID")
  if (!env.workos.requiredOrgId()) missing.push("WORKOS_REQUIRED_ORG_ID")
  if (!env.sync.webhookSecret()) missing.push("SYNC_WEBHOOK_SECRET")

  if (missing.length > 0) {
    throw new Error(
      `refusing to start in production without authentication — missing: ${missing.join(", ")}. ` +
        "Set the variables (fly secrets set …) or run with NODE_ENV!=production for local development.",
    )
  }
}

assertProductionAuthConfig()

const app = createApp()

startScheduler().catch((err) => {
  log.error("scheduler bootstrap failed", { error: formatError(err) })
})

serve({ fetch: app.fetch, port: env.port }, ({ port }) => {
  console.warn(`server listening on http://localhost:${port}`)
})
