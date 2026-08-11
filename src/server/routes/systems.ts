import { Hono } from "hono"
import { systemStatuses } from "../integrations/systems.js"

const app = new Hono()

app.get("/", (c) => c.json(systemStatuses()))

export default app
