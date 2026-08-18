import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FIELD_CATALOG } from "../integrations/shared/field-catalog.js"

// Die Routen laden Discovery live von Dimacon/Clockin — ohne Credentials
// schlägt sie natürlich fehl (getDimaconClient wirft "Missing required env
// var"). Genau dieses Verhalten testen wir hier: kein Mock der SDKs nötig.
const CLIENT_ENV = [
  "DIMACON_API_TOKEN",
  "DIMACON_BASE_URL",
  "DIMACON_TENANT",
  "CLOCKIN_API_TOKEN",
  "CLOCKIN_BASE_URL",
] as const

interface EntityBlockJson {
  entity: string
  isDefault: boolean
  rules: unknown[]
  discoveryErrors: string[]
}

const std = (field: string) => ({ kind: "standard", field })

const VALID_RULES = [
  { source: std("name"), target: std("name") },
  { source: std("street"), target: std("destination_street") },
]

let dir: string
let app: Hono

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mappings-test-"))
  vi.stubEnv("SETTINGS_PATH", join(dir, "settings.json"))
  // Garantiert unset, auch wenn die Shell des Entwicklers sie gesetzt hat —
  // Discovery muss deterministisch scheitern, ohne Netz.
  for (const name of CLIENT_ENV) vi.stubEnv(name, undefined)
  vi.stubEnv("SYNC_CRON", undefined)
  vi.stubEnv("SYNC_TZ", undefined)
  vi.resetModules()

  const { default: mappings } = await import("./mappings.js")
  const { log } = await import("../lib/log.js")
  // Route + Settings loggen über den globalen Logger — stumm schalten
  log.info = () => {
    /* swallow */
  }

  app = new Hono()
  app.route("/api/mappings", mappings)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

function putProject(rules: unknown) {
  return app.request("/api/mappings/dimacon-clockin/project", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules }),
  })
}

async function getProjectBlock(): Promise<EntityBlockJson> {
  const res = await app.request("/api/mappings/dimacon-clockin")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { entities: EntityBlockJson[] }
  const block = body.entities.find((e) => e.entity === "project")
  if (!block) throw new Error("project entity block missing in GET response")
  return block
}

describe("mappings routes", () => {
  it("returns 404 on GET for an unknown integration", async () => {
    const res = await app.request("/api/mappings/unknown-integration")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "integration has no field mapping" })
  })

  it("returns 404 on PUT when the entity does not belong to the integration", async () => {
    // lexofficeContact gehört zu dimacon-lexoffice, nicht zu dimacon-clockin
    const res = await app.request("/api/mappings/dimacon-clockin/lexofficeContact", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules: VALID_RULES }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "unknown integration or entity" })
  })

  it("accepts standard-only rules despite failing discovery and persists them", async () => {
    const res = await putProject(VALID_RULES)
    expect(res.status).toBe(200)

    const block = (await res.json()) as EntityBlockJson
    expect(block.isDefault).toBe(false)
    expect(block.rules).toEqual(VALID_RULES)
    expect(block.discoveryErrors.length).toBeGreaterThan(0)

    const fetched = await getProjectBlock()
    expect(fetched.isDefault).toBe(false)
    expect(fetched.rules).toEqual(VALID_RULES)
  })

  it("rejects attribute-source rules with 502 when discovery fails and persists nothing", async () => {
    const res = await putProject([
      { source: std("name"), target: std("name") },
      { source: { kind: "attribute", attributeId: "attr-1" }, target: std("department") },
    ])
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/^Discovery fehlgeschlagen: /)

    const fetched = await getProjectBlock()
    expect(fetched.isDefault).toBe(true)
  })

  it("rejects a body without a rules key with 400", async () => {
    const res = await app.request("/api/mappings/dimacon-clockin/project", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid input")
  })

  it("rejects more than 100 rules with 400", async () => {
    const rules = Array.from({ length: 101 }, () => ({
      source: std("name"),
      target: std("name"),
    }))
    const res = await putProject(rules)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid input")
  })

  it("rejects a rule targeting the locked field number with 400 and details", async () => {
    const res = await putProject([
      { source: std("name"), target: std("name") },
      { source: std("street"), target: std("number") },
    ])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; details: string[] }
    expect(body.error).toBe("invalid mapping")
    expect(body.details).toEqual([expect.stringContaining('Zielfeld "number" ist fixiert')])
  })

  it("rejects an empty rules array because the required target name is unmapped", async () => {
    const res = await putProject([])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; details: string[] }
    expect(body.error).toBe("invalid mapping")
    expect(body.details).toEqual(['Pflicht-Ziel "name" hat keine Regel'])
  })

  it("resets to the default rules via DELETE after a successful PUT", async () => {
    const put = await putProject(VALID_RULES)
    expect(put.status).toBe(200)
    expect(((await put.json()) as EntityBlockJson).isDefault).toBe(false)

    const del = await app.request("/api/mappings/dimacon-clockin/project", { method: "DELETE" })
    expect(del.status).toBe(200)
    expect(((await del.json()) as EntityBlockJson).isDefault).toBe(true)

    const fetched = await getProjectBlock()
    expect(fetched.isDefault).toBe(true)
    expect(fetched.rules).toEqual(FIELD_CATALOG.project.defaultRules)
  })
})
