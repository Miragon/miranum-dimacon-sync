import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { readFile } from "node:fs/promises"
import clockin from "./routes/clockin.js"
import dimacon from "./routes/dimacon.js"
import lexoffice from "./routes/lexoffice.js"
import sync from "./routes/sync.js"
import { env } from "./lib/env.js"
import { startScheduler } from "./sync/scheduler.js"

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))

app.route("/api/clockin", clockin)
app.route("/api/dimacon", dimacon)
app.route("/api/lexoffice", lexoffice)
app.route("/api/sync", sync)

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message }, 500)
})

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist/client" }))
  app.get("/*", async (c) => {
    const html = await readFile("./dist/client/index.html", "utf-8")
    return c.html(html)
  })
}

startScheduler()

serve({ fetch: app.fetch, port: env.port }, ({ port }) => {
  console.warn(`server listening on http://localhost:${port}`)
})
