import { Hono } from "hono"
import { isRunning } from "../integrations/mutex.js"
import { getIntegration } from "../integrations/registry.js"
import { getNextRun, isCronActive } from "../integrations/scheduler.js"
import { handleIntegrationRun } from "./integrations.js"

/**
 * Legacy-Alias für die Dimacon⇄Clockin-Integration. Externe Webhooks
 * (`POST /api/sync/run` mit SYNC_WEBHOOK_SECRET) und Status-Checks
 * (`GET /api/sync/healthz`) erreichen weiter dieselbe Integration — ACHTUNG:
 * ohne Body läuft der komplette Schritt-Satz inklusive Live-Mitarbeiter-
 * Abgleich; nur Tagesplanung = `{ "steps": { "employees": false } }`.
 * Neue Consumer nutzen `/api/integrations/dimacon-clockin/...`.
 */
const LEGACY_ID = "dimacon-clockin"

const app = new Hono()

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    cronActive: isCronActive(LEGACY_ID),
    nextRun: getNextRun(LEGACY_ID),
    running: isRunning(LEGACY_ID),
  }),
)

app.post("/run", (c) => {
  const def = getIntegration(LEGACY_ID)
  if (!def) return c.json({ error: "unknown integration" }, 404)
  return handleIntegrationRun(def, c)
})

export default app
