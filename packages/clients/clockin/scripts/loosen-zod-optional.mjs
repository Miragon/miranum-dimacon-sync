#!/usr/bin/env node
// Loosen overly-strict zod constraints in zod.gen.ts that the ClockIn
// backend actually violates in practice, so MCP clients validating the
// advertised outputSchema don't reject perfectly valid responses.
//
// Rewrites (applied in order):
//
// 1. `.optional()` -> `.nullish()`
//    ClockIn serializes nullable fields as explicit `null` rather than
//    omitting them. `.optional()` rejects `null`; `.nullish()` is the
//    union of `.optional()` and `.nullable()`.
//
// 2. `z.iso.datetime()` -> `z.iso.datetime({ offset: true, local: true })`
//    Zod 4's strict ISO datetime only accepts `...Z` UTC. Real backends
//    emit offsets (`+02:00`) or naive local times.
//
// 3. `z.number()` -> `z.coerce.number()`
//    ClockIn returns some numeric fields (e.g. hourly_wage) as JSON
//    strings, not numbers. coerce parses "10.50" -> 10.5 so validation
//    succeeds; the original string passes through to the client.
//
// 4. `max_vacation_days: z.object({...}).nullish()` -> array-or-object
//    The OpenAPI spec models max_vacation_days as an object on the
//    EmployeeResource (list-response) variant, but the API actually
//    returns the same array-of-objects shape as on full Employee. Wrap
//    in `z.union([z.array(...), z.object(...)])` so both pass.
//
// 5. `z.iso.date()` -> `z.string()`
//    ClockIn returns date-only fields (birthday, entry_date,
//    contract_ending, trial_period_end_date, workday, …) in formats
//    the strict `YYYY-MM-DD` regex rejects — sometimes with a time
//    component, sometimes empty, sometimes localised. Drop the format
//    check; the field stays a string and real values pass through.
//
// Trade-off: input schemas that share entity types become equally
// lenient. An LLM tool-call could now pass `null`, a non-UTC datetime,
// or a string for a numeric field. The API still does its own
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

// Coerce numbers so stringified numeric fields like hourly_wage pass.
// Only target `z.number()` exactly — leaves `z.number().int()`,
// `z.number().min(…)` etc. untouched so chained validators still work
// (z.coerce.number() returns a different ZodPipeline that does not
// chain `.int()` cleanly).
const numberBefore = (src.match(/z\.number\(\)/g) || []).length
src = src.replace(/z\.number\(\)/g, "z.coerce.number()")

// The EmployeeResource variant declares max_vacation_days as a single
// object, but the API returns the same array shape as on Employee.
// Match the lone-object form and wrap it in a union with the array
// form so both validate.
const objMaxRe =
  /max_vacation_days:\s*z\.object\(\{\s*days:\s*z\.int\(\)\.nullish\(\),\s*year:\s*z\.int\(\)\.nullish\(\)\s*\}\)\.nullish\(\)/g
const maxVacBefore = (src.match(objMaxRe) || []).length
src = src.replace(
  objMaxRe,
  "max_vacation_days: z.union([z.array(z.object({ days: z.int().nullish(), year: z.int().nullish() })), z.object({ days: z.int().nullish(), year: z.int().nullish() })]).nullish()",
)

const isoDateBefore = (src.match(/z\.iso\.date\(\)/g) || []).length
src = src.replace(/z\.iso\.date\(\)/g, "z.string()")

writeFileSync(file, src)
console.warn(
  `loosen-zod-optional: rewrote ${optionalBefore} .optional() -> .nullish(), ` +
    `${datetimeBefore} z.iso.datetime() widened, ` +
    `${numberBefore} z.number() -> z.coerce.number(), ` +
    `${maxVacBefore} max_vacation_days object-form unioned with array-form, ` +
    `${isoDateBefore} z.iso.date() -> z.string()`,
)
