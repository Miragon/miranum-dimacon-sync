import pLimit from "p-limit"

export const DEFAULT_CONCURRENCY = 3

export function createLimit(concurrency = DEFAULT_CONCURRENCY) {
  return pLimit(concurrency)
}

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
  retryOn?: (err: unknown) => boolean
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4
  const baseMs = opts.baseMs ?? 1_000
  const maxMs = opts.maxMs ?? 8_000
  const retryOn = opts.retryOn ?? isTransient

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === attempts || !retryOn(err)) throw err
      const wait = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr
}

const RATE_LIMIT_PHRASES = /too\s+many\s+attempts|too\s+many\s+requests|rate\s*limit|throttl/i

export function isTransient(err: unknown): boolean {
  if (!err) return false

  if (typeof err === "object") {
    const e = err as { message?: unknown; status?: unknown; code?: unknown }

    if (typeof e.status === "number" && (e.status === 429 || (e.status >= 500 && e.status < 600))) {
      return true
    }

    const code = typeof e.code === "string" ? e.code : ""
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN") return true

    const msg = typeof e.message === "string" ? e.message : ""
    if (msg && (matchStatus(msg) || RATE_LIMIT_PHRASES.test(msg))) return true
  }

  if (typeof err === "string" && (matchStatus(err) || RATE_LIMIT_PHRASES.test(err))) return true

  return false
}

function matchStatus(s: string): boolean {
  return /\b(429|5\d\d)\b/.test(s)
}
