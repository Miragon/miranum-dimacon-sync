import { fileURLToPath } from "node:url"
import type pg from "pg"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import type { Db } from "./client.js"

// fileURLToPath statt URL.pathname: Letzteres liefert "/C:/..." auf Windows.
export function migrationsFolder(): string {
  return fileURLToPath(new URL("./migrations", import.meta.url))
}

/**
 * Serialisiert Migration + Seed über Prozesse hinweg (Rolling-Deploy auf Fly
 * kann kurzzeitig zwei Maschinen booten). Advisory-Locks sind Session-gebunden,
 * deshalb hält EINE dedizierte Pool-Connection den Lock, bis fn fertig ist —
 * db.execute() über den Pool würde Lock und Unlock auf verschiedene
 * Connections verteilen. Ohne Pool (PGlite in Tests) läuft fn ungelockt:
 * dort gibt es nur eine Session.
 */
export async function withBootLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  // $client fehlt im NodePgDatabase-Typ dieser drizzle-Version, existiert aber
  // zur Laufzeit; PGlite (Tests) hat keinen Pool → connect fehlt → ungelockt.
  const client = (db as unknown as { $client?: Partial<pg.Pool> }).$client
  if (!client || typeof client.connect !== "function") return fn()

  const conn = await client.connect()
  try {
    await conn.query("SELECT pg_advisory_lock(hashtext('miranum-sync-boot'))")
    try {
      return await fn()
    } finally {
      await conn.query("SELECT pg_advisory_unlock(hashtext('miranum-sync-boot'))")
    }
  } finally {
    conn.release()
  }
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() })
}
