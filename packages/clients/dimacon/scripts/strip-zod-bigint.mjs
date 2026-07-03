#!/usr/bin/env node
// Replace `z.coerce.bigint().min(BigInt(...)).max(BigInt(...))` chains with
// `z.number().int()` in generated zod.gen.ts.
//
// MCP servers JSON.stringify each tool's zod schema for telemetry (see
// mcp-use's createServerRunEventData). BigInt values inside a zod schema's
// internal definition (here the int64 .min/.max bounds) make that call
// throw, which kills the whole `tools/list` and "server run" reporting.
// The int64 fields surfaced by dimacon are IDs and counts that fit safely
// in JS numbers, so swapping to z.number().int() is a sound trade.
//
// The pattern is matched whitespace-insensitively so it works both for
// prettier-formatted (multi-line) and minified outputs.
import { readFileSync, writeFileSync } from "node:fs"

const file = new URL("../src/generated/zod.gen.ts", import.meta.url)
const src = readFileSync(file, "utf8")

const chain =
  /z\.coerce\s*\.\s*bigint\(\)\s*\.\s*min\(\s*BigInt\(\s*["'][^"']+["']\s*\)\s*,\s*\{\s*error:\s*["'][^"']+["']\s*,?\s*\}\s*\)\s*\.\s*max\(\s*BigInt\(\s*["'][^"']+["']\s*\)\s*,\s*\{\s*error:\s*["'][^"']+["']\s*,?\s*\}\s*\)/g

const removed = (src.match(chain) || []).length
const next = src.replace(chain, "z.number().int()")
const remaining = (next.match(/z\.coerce\s*\.\s*bigint\(\)/g) || []).length
if (remaining > 0) {
  console.error(
    `strip-zod-bigint: ${remaining} z.coerce.bigint() chain(s) did not match the expected pattern`,
  )
  process.exit(1)
}
writeFileSync(file, next)
console.log(`strip-zod-bigint: rewrote ${removed} bigint chain(s)`)
