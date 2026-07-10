import { Hono } from "hono"
import { sdk } from "@miragon/client-dimacon"
import { getDimaconClient } from "../lib/clients.js"

const app = new Hono()

app.get("/me", async (c) => {
  const data = await sdk.getCurrentUser({ client: getDimaconClient() })
  return c.json(data)
})

export default app
