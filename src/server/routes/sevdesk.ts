import { Hono } from "hono"
import { getClientsForTenant } from "../lib/clients.js"
import type { AppEnv } from "../lib/tenant.js"
import { probeErrorResponse } from "./probe-error.js"

const app = new Hono<AppEnv>()

// Probe mit GESPEICHERTEN Tenant-Credentials (das Formular-Testen macht
// /api/credentials/sevdesk/test). Antwort bewusst auf die Trefferzahl
// reduziert — kein Kontakt-Dump über einen Ops-Endpunkt.
app.get("/probe", async (c) => {
  try {
    const client = await getClientsForTenant(c.get("tenant").id).sevdesk()
    const data = await client.get<{ total?: string | number }>("/Contact", {
      limit: "1",
      countAll: "true",
    })
    return c.json({ ok: true, contacts: data.total ?? null })
  } catch (err) {
    const mapped = probeErrorResponse(c, err)
    if (mapped) return mapped
    throw err
  }
})

export default app
