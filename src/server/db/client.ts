import pg from "pg"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import * as schema from "./schema.js"

/**
 * Repositories typisieren gegen dieses Interface — es deckt auch die
 * PGlite-Test-DB ab (strukturgleiches Drizzle-API, anderer Treiber).
 */
export type Db = NodePgDatabase<typeof schema>

const DEV_DEFAULT_URL = "postgres://postgres:postgres@localhost:5400/miranum_sync"

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (url && url.length > 0) return url
  if (process.env.NODE_ENV === "production") {
    throw new Error("Missing required env var: DATABASE_URL")
  }
  return DEV_DEFAULT_URL
}

let _pool: pg.Pool | undefined
let _db: Db | undefined

export function getDb(): Db {
  if (_testDb) return _testDb
  if (!_db) {
    _pool = new pg.Pool({ connectionString: databaseUrl(), max: 5 })
    _db = drizzle(_pool, { schema })
  }
  return _db
}

export async function closeDb(): Promise<void> {
  const pool = _pool
  _pool = undefined
  _db = undefined
  if (pool) await pool.end()
}

let _testDb: Db | undefined

/** Nur für Tests: ersetzt getDb() durch eine (PGlite-)Instanz. */
export function setDbForTests(db: Db | undefined): void {
  _testDb = db
}
