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

  it("treats an empty WORKOS_API_KEY as unset", () => {
    process.env.WORKOS_API_KEY = ""
    expect(env.workos.apiKey()).toBeUndefined()
  })
})

describe("env.tuning", () => {
  it("liefert ohne Env die konservativen Defaults", () => {
    delete process.env.RATE_LIMIT_LEXOFFICE_RPS
    delete process.env.RATE_LIMIT_LEXOFFICE_BURST
    delete process.env.CONCURRENCY_LEXOFFICE
    // Lexware Office: laut Doku 2 Requests/Sekunde.
    expect(env.tuning("lexoffice")).toEqual({ ratePerSec: 2, burst: 2, concurrency: 2 })
    expect(env.tuning("dimacon")).toEqual({ ratePerSec: 10, burst: 20, concurrency: 8 })
    expect(env.tuning("clockin")).toEqual({ ratePerSec: 5, burst: 10, concurrency: 5 })
  })

  it("übernimmt numerische Overrides", () => {
    process.env.RATE_LIMIT_CLOCKIN_RPS = "1.5"
    process.env.RATE_LIMIT_CLOCKIN_BURST = "3"
    process.env.CONCURRENCY_CLOCKIN = "2"
    expect(env.tuning("clockin")).toEqual({ ratePerSec: 1.5, burst: 3, concurrency: 2 })
  })

  it("fällt bei leeren, nicht-numerischen oder ≤0-Werten auf den Default zurück", () => {
    process.env.RATE_LIMIT_DIMACON_RPS = ""
    process.env.RATE_LIMIT_DIMACON_BURST = "viel"
    process.env.CONCURRENCY_DIMACON = "0"
    expect(env.tuning("dimacon")).toEqual({ ratePerSec: 10, burst: 20, concurrency: 8 })
    process.env.CONCURRENCY_DIMACON = "-4"
    expect(env.tuning("dimacon").concurrency).toBe(8)
  })
})
