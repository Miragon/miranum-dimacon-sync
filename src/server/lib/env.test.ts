import { afterEach, describe, expect, it } from "vitest"
import { env } from "./env.js"

const ORIGINAL = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL }
})

// Die Integrations-Credentials sind keine Laufzeit-Env mehr (liegen je
// Mandant verschlüsselt in Postgres); URL-Validierung siehe url.test.ts.
describe("env", () => {
  it("reports a missing DATABASE_URL", () => {
    delete process.env.DATABASE_URL
    expect(() => env.database.url()).toThrow(/Missing required env var: DATABASE_URL/)
  })

  it("returns DATABASE_URL when set", () => {
    process.env.DATABASE_URL = "postgres://x:y@localhost:5432/db"
    expect(env.database.url()).toBe("postgres://x:y@localhost:5432/db")
  })

  it("treats an empty WORKOS_CLIENT_ID as unset", () => {
    process.env.WORKOS_CLIENT_ID = ""
    expect(env.workos.clientId()).toBeUndefined()
  })
})
