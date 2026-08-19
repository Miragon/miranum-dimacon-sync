import "dotenv/config"

import { serve } from "@hono/node-server"
import { sql } from "drizzle-orm"
import { createApp } from "./app.js"
import { closeDb, getDb } from "./db/client.js"
import { runMigrations, withBootLock } from "./db/migrate.js"
import { seedOrThrow } from "./db/seed-legacy.js"
import { env } from "./lib/env.js"
import { formatError } from "./lib/errors.js"
import { log } from "./lib/log.js"
import { startScheduler, stopScheduler } from "./integrations/scheduler.js"

/**
 * Produktions-Guard: nie unauthentifiziert, nie ohne DB, nie ohne
 * Verschlüsselungs-Key betreiben. WORKOS_REQUIRED_ORG_ID und
 * SYNC_WEBHOOK_SECRET sind KEINE Laufzeit-Pflicht mehr — die tenants-Tabelle
 * ist die Allowlist, Webhook-Secrets liegen je Mandant in der DB; beide
 * Env-Vars dienen nur noch als Input des einmaligen Legacy-Seeds.
 */
function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return

  const missing: string[] = []
  if (!env.workos.clientId()) missing.push("WORKOS_CLIENT_ID")
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL")
  if (!process.env.CREDENTIAL_KEYS) missing.push("CREDENTIAL_KEYS")

  if (missing.length > 0) {
    throw new Error(
      `refusing to start in production — missing: ${missing.join(", ")}. ` +
        "Set the variables (fly secrets set …) or run with NODE_ENV!=production for local development.",
    )
  }
}

assertProductionConfig()

const db = getDb()
await withBootLock(db, async () => {
  await runMigrations(db)
  await seedOrThrow(db)
})

if (process.env.NODE_ENV === "production") {
  const count = await db.execute(sql`SELECT count(*)::int AS n FROM tenants`)
  if ((count.rows[0] as { n: number }).n === 0) {
    log.error("no tenants provisioned — every request will be rejected with 403", {
      hint: "scripts/create-tenant.ts oder Legacy-Seed-Env prüfen",
    })
  }
}

const app = createApp()

startScheduler().catch((err) => {
  log.error("scheduler bootstrap failed", { error: formatError(err) })
})

const server = serve({ fetch: app.fetch, port: env.port }, ({ port }) => {
  console.warn(`server listening on http://localhost:${port}`)
})

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log.info("shutting down", { signal })
  stopScheduler()
  server.close(() => {
    void closeDb().finally(() => process.exit(0))
  })
  // Harte Frist, falls offene Verbindungen das close blockieren.
  setTimeout(() => process.exit(0), 5_000).unref()
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
