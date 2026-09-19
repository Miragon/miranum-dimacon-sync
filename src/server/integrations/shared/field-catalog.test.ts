import { describe, expect, it } from "vitest"
import { FIELD_CATALOG, MAPPABLE_ENTITIES } from "./field-catalog.js"
import { EntityFieldMappingSchema } from "./field-mapping-schema.js"

const ENTITIES = ["project", "customer", "employee", "lexofficeContact", "dimaconCustomer"] as const

describe("FIELD_CATALOG", () => {
  it("default rules parse against the mapping schema", () => {
    for (const entity of ENTITIES) {
      const parsed = EntityFieldMappingSchema.safeParse({
        rules: FIELD_CATALOG[entity].defaultRules,
      })
      expect(parsed.success).toBe(true)
    }
  })

  it("locked target fields are not offered as editable targets", () => {
    for (const entity of ENTITIES) {
      const catalog = FIELD_CATALOG[entity]
      const editable = new Set(catalog.standardTargets.map((t) => t.field))
      for (const locked of catalog.lockedTargetFields) {
        expect(editable.has(locked)).toBe(false)
      }
    }
  })

  it("every locked pair is covered by lockedTargetFields", () => {
    for (const entity of ENTITIES) {
      const catalog = FIELD_CATALOG[entity]
      const locked = new Set(catalog.lockedTargetFields)
      for (const pair of catalog.lockedPairs) {
        expect(locked.has(pair.targetField)).toBe(true)
      }
    }
  })

  it("default rules only reference existing catalog sources and targets", () => {
    for (const entity of ENTITIES) {
      const catalog = FIELD_CATALOG[entity]
      const sources = new Set(catalog.standardSources.map((s) => s.field))
      const targets = new Set(catalog.standardTargets.map((t) => t.field))
      for (const rule of catalog.defaultRules) {
        expect(rule.source.kind).toBe("standard")
        if (rule.source.kind === "standard") expect(sources.has(rule.source.field)).toBe(true)
        expect(rule.target.kind).toBe("standard")
        if (rule.target.kind === "standard") expect(targets.has(rule.target.field)).toBe(true)
      }
    }
  })

  it("required targets exist in the editable target list", () => {
    for (const entity of ENTITIES) {
      const catalog = FIELD_CATALOG[entity]
      const targets = new Set(catalog.standardTargets.map((t) => t.field))
      for (const required of catalog.requiredTargets) {
        expect(targets.has(required)).toBe(true)
      }
    }
  })

  it("mappable integrations reference known entities", () => {
    for (const entities of Object.values(MAPPABLE_ENTITIES)) {
      for (const entity of entities) {
        expect(FIELD_CATALOG[entity]).toBeDefined()
      }
    }
  })
})
