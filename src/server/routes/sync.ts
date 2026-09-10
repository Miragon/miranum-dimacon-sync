import { Hono } from "hono"
import { isRunning } from "../integrations/mutex.js"
import { getIntegration } from "../integrations/registry.js"
import { getNextRun, isCronActive } from "../integrations/scheduler.js"
import { handleIntegrationRun, tenantForStatus } from "./integrations.js"

/**
 * Legacy-Alias für die Dimacon⇄Clockin-Integration. Externe Webhooks
 * (`POST /api/sync/run` mit dem Mandanten-Webhook-Secret) und Status-Checks
 * (`GET /api/sync/healthz`) erreichen weiter dieselbe Integration — der Seed
 * importiert das alte SYNC_WEBHOOK_SECRET als Secret des ersten Mandanten,
 * bestehende Caller laufen also unverändert. ACHTUNG: ohne Body gilt der
 * gespeicherte Umfang aus `/sync/<id>/settings?tab=umfang` (leer = alle
 * Schritte inklusive Live-Mitarbeiter-Abgleich, wie bisher); ein
 * mitgeschickter Body überschreibt ihn feldweise (`steps` eine Ebene tief),
 * nur Tagesplanung = `{ "steps": { "employees": false } }`.
 * Neue Consumer nutzen `/api/integrations/dimacon-clockin/...`.
 */
const LEGACY_ID = "dimacon-clockin"

const app = new Hono()

app.get("/healthz", async (c) => {
  const tenant = await tenantForStatus(c)
  if (!tenant) return c.json({ ok: true })
  return c.json({
    ok: true,
    cronActive: isCronActive(tenant.id, LEGACY_ID),
    nextRun: getNextRun(tenant.id, LEGACY_ID),
    running: isRunning(tenant.id, LEGACY_ID),
  })
})

app.post("/run", (c) => {
  const def = getIntegration(LEGACY_ID)
  if (!def) return c.json({ error: "unknown integration" }, 404)
  return handleIntegrationRun(def, c)
})

export default app
