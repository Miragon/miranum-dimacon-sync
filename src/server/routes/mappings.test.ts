import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setDbForTests, type Db } from "../db/client.js"
import { fieldMappings, tenants } from "../db/schema.js"
import { createTestDb } from "../db/test-db.js"
import { resetClientCacheForTests } from "../lib/clients.js"
import { log } from "../lib/log.js"
import type { AppEnv, Tenant } from "../lib/tenant.js"
import { FIELD_CATALOG } from "../integrations/shared/field-catalog.js"
import mappings from "./mappings.js"

// Die Routen laden Discovery live von Dimacon/Clockin — ohne Credential-
// Zeilen des Mandanten schlägt sie deterministisch und ohne Netz fehl
// (CredentialsMissingError aus der Client-Factory). Genau dieses Verhalten
// testen wir hier: kein Mock der SDKs nötig.

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

let db: Db
let close: () => Promise<void>
let tenant: Tenant
let app: Hono<AppEnv>

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  setDbForTests(db)
  ;[tenant] = await db
    .insert(tenants)
    .values({ workosOrgId: "org_mappings", displayName: "Mappings-Test" })
    .returning()

  log.info = () => {
    /* swallow */
  }

  app = new Hono()
  // Stub-Middleware statt requireAuth/resolveTenant: Tests scopen direkt.
  app.use("*", async (c, next) => {
    c.set("tenant", tenant)
    return next()
  })
  app.route("/api/mappings", mappings)
})

afterAll(async () => {
  setDbForTests(undefined)
  await close()
})

beforeEach(async () => {
  await db.delete(fieldMappings)
  resetClientCacheForTests()
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
    expect(block.discoveryErrors[0]).toMatch(/Zugangsdaten für "dimacon"/)

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
