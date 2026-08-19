import { Hono } from "hono"
import { getClientsForTenant } from "../lib/clients.js"
import type { AppEnv } from "../lib/tenant.js"
import { probeErrorResponse } from "./probe-error.js"

const app = new Hono<AppEnv>()

app.get("/profile", async (c) => {
  try {
    const client = await getClientsForTenant(c.get("tenant").id).lexoffice()
    const data = await client.get("/v1/profile")
    return c.json(data)
  } catch (err) {
    const mapped = probeErrorResponse(c, err)
    if (mapped) return mapped
    throw err
  }
})

export default app
