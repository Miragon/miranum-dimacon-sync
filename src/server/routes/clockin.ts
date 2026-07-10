import { Hono } from "hono"
import { sdk } from "@miragon/client-clockin"
import { getClockInClient } from "../lib/clients.js"

const app = new Hono()

app.get("/projects", async (c) => {
  const data = await sdk.getAListOfProjects({ client: getClockInClient() })
  return c.json(data)
})

export default app
