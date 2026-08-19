import { Hono } from "hono"
import type { AppEnv } from "../lib/tenant.js"
import { systemStatuses } from "../integrations/systems.js"

const app = new Hono<AppEnv>()

app.get("/", async (c) => c.json(await systemStatuses(c.get("tenant").id)))

export default app
