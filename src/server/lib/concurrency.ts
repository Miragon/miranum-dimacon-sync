import pLimit from "p-limit"
import { causeChain } from "./errors.js"
import { env, type RateLimitedSystem } from "./env.js"
import { countRetry } from "./metrics.js"

/** Fallback ohne System-Angabe — unverändertes Verhalten für Bestands-Aufrufer. */
export const DEFAULT_CONCURRENCY = 3

/**
 * Parallelität je Zielsystem: Dimacon-Reads dürfen deutlich höher laufen als
 * Lexware-Writes (2 req/s laut Doku). Ohne Argument bleibt es bei der
 * bisherigen globalen 3.
 *
 * Fasst eine Task mehrere Systeme an (die Kunden-Angleichung schreibt nach
 * Lexware UND Dimacon), gibt das STRENGSTE beteiligte System den Wert vor —
 * `CONCURRENCY_<SYS>` ist eine Obergrenze, keine Garantie.
 */
export function createLimit(system?: RateLimitedSystem | number) {
  if (typeof system === "number") return pLimit(system)
  return pLimit(system ? env.tuning(system).concurrency : DEFAULT_CONCURRENCY)
}

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
  /**
   * Feste Wartezeit bei Rate-Limit-Fehlern OHNE `Retry-After`. Ohne Angabe
   * gilt das gestufte Rate-Limit-Backoff (siehe RATE_LIMIT_BACKOFF_MS) —
   * die frühere Pauschale von 20 s gibt es nicht mehr.
   */
  rateLimitWaitMs?: number
  retryOn?: (err: unknown) => boolean
  sleep?: (ms: number) => Promise<void>
}

/**
 * Rate-Limit-Backoff ohne `Retry-After`-Header. Laravel-Throttle-Fenster
 * (Clockin) sind bis zu 60 s lang, deshalb startet die Staffel bei 5 s statt
 * beim 1/2/4-s-Backoff der Netzwerkfehler — aber gestaffelt statt pauschal,
 * damit ein kurzes Fenster nicht 20 s kostet.
 */
const RATE_LIMIT_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000]

/** Obergrenze jeder Rate-Limit-Wartezeit (auch für Retry-After). */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000

/**
 * Für Aufrufe gegen den Lexware-Client: der retryt 429 bereits selbst mit
 * `Retry-After`. Ein zusätzlicher Retry auf unserer Seite multipliziert
 * Requests und Wartezeit (aus einem logischen Aufruf werden ~20 HTTP-Calls).
 *
 * LOAD-BEARING: an JEDEM `withRetry` um einen Lexware-Aufruf verwenden
 * (dimacon-lexoffice/contact-lookup.ts) — sonst greift die Multiplikation.
 */
export const NO_RATE_LIMIT_RETRY: RetryOptions = {
  retryOn: (err: unknown) => isTransient(err) && !isRateLimited(err),
}

/**
 * Für nicht-idempotente Anlage-Requests (POST auf create*-Endpunkte).
 *
 * LOAD-BEARING: ein 5xx oder ein abgerissener Socket kann bedeuten, dass der
 * Datensatz serverseitig BEREITS angelegt wurde — der Retry legt dann eine
 * Dublette an (dieselbe Abwägung wie beim bewusst retry-freien Lexware-POST
 * in dimacon-lexoffice/aligner.ts). Wiederholt wird deshalb nur, was das
 * Zielsystem nachweislich NICHT verarbeitet hat: ein Rate-Limit weist Laravel
 * vor dem Controller ab, da kann kein halber Insert liegen bleiben.
 */
export const NON_IDEMPOTENT_RETRY: RetryOptions = {
  retryOn: (err: unknown) => isRateLimited(err),
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5
  const baseMs = opts.baseMs ?? 1_000
  const maxMs = opts.maxMs ?? 8_000
  const retryOn = opts.retryOn ?? isTransient
  const sleep = opts.sleep ?? defaultSleep

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === attempts || !retryOn(err)) throw err
      const rateLimited = isRateLimited(err)
      const wait = rateLimited
        ? rateLimitWait(err, attempt, opts.rateLimitWaitMs)
        : Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      countRetry({ waitedMs: wait, rateLimited })
      await sleep(wait)
    }
  }
  throw lastErr
}

/**
 * Wartezeit nach einem Rate-Limit: `Retry-After` des Servers (vom
 * Error-Interceptor angehängt) schlägt jede Schätzung, danach die
 * konfigurierte Festwartezeit, sonst die gestaffelte Backoff-Treppe mit
 * ±20 % Jitter (verhindert, dass parallele Tasks im Gleichschritt
 * wieder auflaufen).
 */
function rateLimitWait(err: unknown, attempt: number, fixedMs?: number): number {
  const fromServer = retryAfterMs(err)
  if (fromServer !== undefined) return fromServer
  if (fixedMs !== undefined) return fixedMs
  const base = RATE_LIMIT_BACKOFF_MS[Math.min(attempt - 1, RATE_LIMIT_BACKOFF_MS.length - 1)]!
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/**
 * `retryAfterMs` aus der cause-Kette (setzt der Error-Interceptor aus dem
 * `Retry-After`-Header, siehe client-instrumentation.ts).
 *
 * Nur POSITIVE Werte gelten als Angabe des Servers: eine 0 (Header `0`,
 * negativ oder ein HTTP-Datum in der Vergangenheit bei Uhr-Drift) ist kein
 * verwertbarer Hinweis und darf die Backoff-Treppe nicht kurzschließen.
 * Der Interceptor filtert das bereits, das hier ist die zweite Bremse.
 */
export function retryAfterMs(err: unknown): number | undefined {
  for (const link of causeChain(err)) {
    if (typeof link !== "object" || link === null) continue
    const value = (link as { retryAfterMs?: unknown }).retryAfterMs
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.min(value, MAX_RATE_LIMIT_WAIT_MS)
    }
  }
  return undefined
}

const RATE_LIMIT_PHRASES = /too\s+many\s+attempts|too\s+many\s+requests|rate\s*limit|throttl/i

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"])

/**
 * Die API-Clients werfen bei HTTP-Fehlern den geparsten Response-Body (den
 * `status` hängt erst unser Error-Interceptor an, siehe
 * client-instrumentation.ts), und undici versteckt Netzwerkfehler-Codes im
 * `cause` — deshalb wird hier die gesamte cause-Kette geprüft, nicht nur das
 * oberste Fehlerobjekt.
 */
export function isTransient(err: unknown): boolean {
  for (const link of causeChain(err)) {
    if (typeof link === "string") {
      if (matchStatus(link) || RATE_LIMIT_PHRASES.test(link)) return true
      continue
    }
    if (typeof link !== "object" || link === null) continue

    const e = link as { message?: unknown; status?: unknown; code?: unknown }

    if (typeof e.status === "number" && (e.status === 429 || (e.status >= 500 && e.status < 600))) {
      return true
    }

    const code = typeof e.code === "string" ? e.code : ""
    if (TRANSIENT_CODES.has(code) || code.startsWith("UND_ERR_")) return true

    const msg = typeof e.message === "string" ? e.message : ""
    if (msg && (matchStatus(msg) || RATE_LIMIT_PHRASES.test(msg) || /socket hang up/i.test(msg))) {
      return true
    }
  }
  return false
}

/**
 * Der Lexware-Client ist handgeschrieben, läuft ohne Error-Interceptor und
 * wirft einen nackten `Error("Lexoffice API 429: <body>")` — ohne `status`
 * und ohne garantierte Throttle-Phrase im Body. Deshalb zählt auch eine 429
 * IM MELDUNGSTEXT als Rate-Limit; sonst griffe weder NO_RATE_LIMIT_RETRY
 * noch die Rate-Limit-Staffel für das einzige System mit dokumentiertem
 * Limit.
 */
export function isRateLimited(err: unknown): boolean {
  for (const link of causeChain(err)) {
    if (typeof link === "string" && isRateLimitText(link)) return true
    if (typeof link === "object" && link !== null) {
      const e = link as { message?: unknown; status?: unknown }
      if (e.status === 429) return true
      if (typeof e.message === "string" && isRateLimitText(e.message)) return true
    }
  }
  return false
}

function isRateLimitText(s: string): boolean {
  return RATE_LIMIT_PHRASES.test(s) || /\b429\b/.test(s)
}

function matchStatus(s: string): boolean {
  return /\b(429|5\d\d)\b/.test(s)
}
