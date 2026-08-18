import pLimit from "p-limit"
import { causeChain } from "./errors.js"

export const DEFAULT_CONCURRENCY = 3

export function createLimit(concurrency = DEFAULT_CONCURRENCY) {
  return pLimit(concurrency)
}

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
  /**
   * Wartezeit bei Rate-Limit-Fehlern. Laravel-Throttle-Fenster (Clockin)
   * sind 60s lang — das exponentielle 1/2/4s-Backoff läuft komplett
   * innerhalb desselben Fensters ab und schlägt daher immer fehl.
   */
  rateLimitWaitMs?: number
  retryOn?: (err: unknown) => boolean
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5
  const baseMs = opts.baseMs ?? 1_000
  const maxMs = opts.maxMs ?? 8_000
  const rateLimitWaitMs = opts.rateLimitWaitMs ?? 20_000
  const retryOn = opts.retryOn ?? isTransient
  const sleep = opts.sleep ?? defaultSleep

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === attempts || !retryOn(err)) throw err
      const wait = isRateLimited(err)
        ? rateLimitWaitMs
        : Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      await sleep(wait)
    }
  }
  throw lastErr
}

const RATE_LIMIT_PHRASES = /too\s+many\s+attempts|too\s+many\s+requests|rate\s*limit|throttl/i

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"])

/**
 * Die API-Clients werfen bei HTTP-Fehlern den geparsten Response-Body ohne
 * `status`-Feld, und undici versteckt Netzwerkfehler-Codes im `cause` —
 * deshalb wird hier die gesamte cause-Kette geprüft, nicht nur das
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

export function isRateLimited(err: unknown): boolean {
  for (const link of causeChain(err)) {
    if (typeof link === "string" && RATE_LIMIT_PHRASES.test(link)) return true
    if (typeof link === "object" && link !== null) {
      const e = link as { message?: unknown; status?: unknown }
      if (e.status === 429) return true
      if (typeof e.message === "string" && RATE_LIMIT_PHRASES.test(e.message)) return true
    }
  }
  return false
}

function matchStatus(s: string): boolean {
  return /\b(429|5\d\d)\b/.test(s)
}
