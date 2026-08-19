import { Hono } from "hono"
import { sdk } from "@miragon/client-dimacon"
import { getClientsForTenant } from "../lib/clients.js"
import type { AppEnv } from "../lib/tenant.js"
import { probeErrorResponse } from "./probe-error.js"

const app = new Hono<AppEnv>()

app.get("/me", async (c) => {
  try {
    const client = await getClientsForTenant(c.get("tenant").id).dimacon()
    const data = await sdk.getCurrentUser({ client })
    return c.json(data)
  } catch (err) {
    const mapped = probeErrorResponse(c, err)
    if (mapped) return mapped
    throw err
  }
})

export default app
