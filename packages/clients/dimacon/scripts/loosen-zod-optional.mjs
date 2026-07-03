#!/usr/bin/env node
// Loosen overly-strict zod constraints in zod.gen.ts that the Dimacon
// backend actually violates in practice, so MCP clients validating the
// advertised outputSchema don't reject perfectly valid responses.
//
// Two rewrites:
//
// 1. `.optional()` -> `.nullish()`
//    Dimacon serializes nullable fields as explicit `null` rather than
//    omitting them. `.optional()` rejects `null`; `.nullish()` is the
//    union of `.optional()` and `.nullable()`.
//
// 2. `z.iso.datetime()` -> `z.iso.datetime({ offset: true, local: true })`
//    Zod 4's `z.iso.datetime()` only accepts the strict `...Z` UTC form.
//    Dimacon returns timestamps with timezone offsets (`+02:00`) or no
//    timezone at all. The widened call accepts UTC, offsets, and naive
//    local times — covers everything plausible from a Spring backend.
//
// Trade-off: input schemas that share entity types become equally
// lenient. An LLM tool-call could now pass `null` instead of omitting
// a field, or a non-UTC datetime string. The API still does its own
// server-side validation, so this is harmless in the MCP context.
import { readFileSync, writeFileSync } from "node:fs"

const file = new URL("../src/generated/zod.gen.ts", import.meta.url)
let src = readFileSync(file, "utf8")

const optionalBefore = (src.match(/\.optional\(\)/g) || []).length
src = src.replace(/\.optional\(\)/g, ".nullish()")
const optionalAfter = (src.match(/\.optional\(\)/g) || []).length
if (optionalAfter !== 0) {
  console.error(`loosen-zod-optional: ${optionalAfter} .optional() call(s) survived the rewrite`)
  process.exit(1)
}

const datetimeBefore = (src.match(/z\.iso\.datetime\(\)/g) || []).length
src = src.replace(/z\.iso\.datetime\(\)/g, "z.iso.datetime({ offset: true, local: true })")
const datetimeAfter = (src.match(/z\.iso\.datetime\(\)/g) || []).length
if (datetimeAfter !== 0) {
  console.error(
    `loosen-zod-optional: ${datetimeAfter} z.iso.datetime() call(s) survived the rewrite`,
  )
  process.exit(1)
}

writeFileSync(file, src)
console.log(
  `loosen-zod-optional: rewrote ${optionalBefore} .optional() -> .nullish(), ${datetimeBefore} z.iso.datetime() -> z.iso.datetime({ offset: true, local: true })`,
)
