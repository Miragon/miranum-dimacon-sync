import { getStoredRunDefaults } from "../db/repos/schedules.js"
import type { IntegrationDefinition } from "./types.js"

/**
 * Flüchtige Input-Keys, die NIE persistiert werden dürfen: das Datum eines
 * Laufs ist beim Cron immer „heute" und darf sich nicht aus einem alten
 * Formular-Absender in einen späteren Lauf schmuggeln. Persistiert wird nur,
 * was den Umfang bestimmt (`steps`, `dryRun`).
 */
export const VOLATILE_RUN_KEYS = ["date"] as const

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Entfernt die flüchtigen Keys; Nicht-Objekte werden zu `{}`. */
export function stripVolatileRunKeys(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {}
  const out: Record<string, unknown> = { ...value }
  for (const key of VOLATILE_RUN_KEYS) delete out[key]
  return out
}

/**
 * Request-Body ÜBER gespeicherte Defaults legen: Abweichungen gelten so nur
 * für den einzelnen Lauf. Top-Level gewinnt der Override; verschachtelte
 * Plain-Objects (praktisch `steps`) werden EINE Ebene tief gemerged, damit
 * `{steps:{employees:false}}` die übrigen gespeicherten Schritte nicht
 * mitlöscht. Ein Nicht-Objekt-Override wird unverändert durchgereicht —
 * kaputte Bodies sollen weiterhin exakt dieselbe 400-Antwort erzeugen.
 */
export function mergeRunInput(defaults: Record<string, unknown>, override: unknown): unknown {
  if (!isPlainObject(override)) return override
  const out: Record<string, unknown> = { ...defaults }
  for (const [key, value] of Object.entries(override)) {
    const base = defaults[key]
    out[key] = isPlainObject(base) && isPlainObject(value) ? { ...base, ...value } : value
  }
  return out
}

export type RunDefaultsParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; details: unknown }

/**
 * Validiert einen zu speichernden Run-Umfang gegen das `inputSchema` der
 * Integration (generisch — neue Integrationen brauchen nichts dazuzutun) und
 * gibt die normalisierte, datumsfreie Form zurück. Vor UND nach dem Parse
 * gestrippt: `date` darf weder vom Client kommen noch durch ein
 * Schema-Default entstehen.
 */
export function parseRunDefaults(def: IntegrationDefinition, raw: unknown): RunDefaultsParse {
  const parsed = def.inputSchema.safeParse(stripVolatileRunKeys(raw))
  if (!parsed.success) return { ok: false, details: parsed.error.flatten() }
  if (!isPlainObject(parsed.data)) {
    return { ok: false, details: { formErrors: ["run defaults must be an object"] } }
  }
  return { ok: true, value: stripVolatileRunKeys(parsed.data) }
}

/**
 * Gespeicherte Defaults des Mandanten in normalisierter Form. Keine Zeile /
 * `{}` ⇒ `{}` — bit-identisch zum früheren `inputSchema.parse({})`.
 *
 * Ein gespeichertes NICHT-Objekt (nur per SQL erreichbar — der PUT-Pfad
 * erzwingt via `z.record` ein Objekt) wird abgelehnt statt zu `{}` geglättet:
 * geglättet fiele der Lauf auf die vollen Schema-Defaults zurück („alles an,
 * live") — genau der Massen-Write, den fail-closed ausschließt.
 */
async function loadRunDefaults(
  def: IntegrationDefinition,
  tenantId: string,
): Promise<RunDefaultsParse> {
  const stored = await getStoredRunDefaults(tenantId, def.id)
  if (stored !== undefined && !isPlainObject(stored)) {
    return { ok: false, details: { formErrors: ["stored run defaults must be an object"] } }
  }
  return parseRunDefaults(def, stored ?? {})
}

// Kein Pfad-Platzhalter im Text: die Meldung landet 1:1 in der Run-Historie,
// wo der Nutzer sonst wörtlich „/sync/<id>/settings" liest.
export const INVALID_STORED_DEFAULTS_MESSAGE =
  "Der gespeicherte Umfang dieser Integration ist ungültig — " +
  "bitte in den Einstellungen der Integration im Tab Umfang neu speichern"

export type ScheduledInputResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; message: string; details: unknown }

/**
 * Input eines GEPLANTEN Laufs. Fail-closed: sind die gespeicherten Defaults
 * ungültig (z. B. nach einer Schema-Änderung oder per SQL manipuliert), wird
 * der Lauf übersprungen statt auf die Schema-Defaults zurückzufallen — die
 * wären „alles an, live" und damit genau der Massen-Write, den der Mandant
 * mit seiner Einstellung ausgeschlossen hat. Ein ausgefallener Cron ist laut
 * (log.error) und reparierbar; ein ungewollter Live-Lauf ist es nicht.
 */
export async function resolveScheduledInput(
  def: IntegrationDefinition,
  tenantId: string,
): Promise<ScheduledInputResult> {
  const parsed = await loadRunDefaults(def, tenantId)
  if (!parsed.ok) {
    return { ok: false, message: INVALID_STORED_DEFAULTS_MESSAGE, details: parsed.details }
  }
  return { ok: true, input: parsed.value }
}

export type RunInputResult =
  | { ok: true; input: unknown }
  | { ok: false; error: string; details: unknown }

/**
 * Input eines ausgelösten Laufs (UI, Webhook, Legacy-`/api/sync/run`):
 * Request-Body über den gespeicherten Umfang gelegt. Ohne Body gilt damit
 * der gespeicherte Umfang, mit Body gelten die Abweichungen nur für diesen
 * Lauf. Ungültige gespeicherte Defaults blockieren auch hier (400 mit
 * eindeutiger Meldung) — dieselbe fail-closed-Haltung wie beim Cron.
 */
export async function resolveRunInput(
  def: IntegrationDefinition,
  tenantId: string,
  raw: unknown,
): Promise<RunInputResult> {
  const defaults = await loadRunDefaults(def, tenantId)
  if (!defaults.ok) {
    return { ok: false, error: INVALID_STORED_DEFAULTS_MESSAGE, details: defaults.details }
  }
  const parsed = def.inputSchema.safeParse(mergeRunInput(defaults.value, raw))
  if (!parsed.success) {
    return { ok: false, error: "invalid input", details: parsed.error.flatten() }
  }
  return { ok: true, input: parsed.data }
}
