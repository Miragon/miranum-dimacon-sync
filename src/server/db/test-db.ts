import { fileURLToPath } from "node:url"
import type { Db } from "./client.js"
import * as schema from "./schema.js"

/**
 * In-Memory-Postgres (PGlite) für Tests — echtes SQL/Constraints/jsonb ohne
 * Docker. Dynamische Imports sind Pflicht: @electric-sql/pglite ist
 * devDependency und fehlt im geprunten Prod-Image; ein statischer Import
 * würde dort schon beim Modul-Load crashen.
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite")
  const { drizzle } = await import("drizzle-orm/pglite")
  const { migrate } = await import("drizzle-orm/pglite/migrator")

  const pglite = new PGlite()
  const db = drizzle(pglite, { schema })
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)),
  })
  // PgliteDatabase und NodePgDatabase sind API-gleich, aber nominal
  // verschieden typisiert — Repos programmieren gegen Db.
  return { db: db as unknown as Db, close: () => pglite.close() }
}
