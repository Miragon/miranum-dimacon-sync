import { env, type RateLimitedSystem } from "./env.js"

/**
 * Proaktives Throttling: statt zu feuern, bis das Zielsystem 429 antwortet,
 * hält ein Token-Bucket je (Mandant, System) die Request-Rate unter dem
 * Limit. Das ist schneller (keine Retry-Kaskade) UND schonender.
 *
 * LOAD-BEARING: der Bucket ist je (Mandant, System) gescopt — ein global
 * geteilter Bucket würde Mandanten gegenseitig ausbremsen.
 */

export interface TokenBucketOptions {
  ratePerSec: number
  burst?: number
  /** Injizierbar für Tests — MUSS die injizierte Uhr mitbewegen. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface TokenBucketStats {
  tokens: number
  ratePerSec: number
  burst: number
  pausedForMs: number
}

export interface TokenBucket {
  /** Wartet, bis ein Token frei ist. FIFO in Aufrufreihenfolge. */
  acquire(): Promise<void>
  /** Globale Sperre des Systems (z. B. nach einem 429 mit Retry-After). */
  pauseFor(ms: number): void
  stats(): TokenBucketStats
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Reißleine gegen Endlosschleifen, falls eine Uhr nicht vorrückt. */
const MAX_SPINS = 10_000

/**
 * Die Reißleine ist FAIL-CLOSED: lieber ein sichtbar gescheiterter Request
 * als ein still ungedrosselter. Erreichbar ist sie praktisch nur bei einer
 * kaputten Uhr — jeder reguläre Spin schläft exakt so lange, bis ein Token
 * bzw. das Ende der Sperre fällig ist.
 */
export class TokenBucketStalledError extends Error {
  readonly code = "TOKEN_BUCKET_STALLED"
  constructor() {
    super("Rate-Limit-Drosselung kam nicht voran (Systemuhr?) — Request abgebrochen")
    this.name = "TokenBucketStalledError"
  }
}

export function createTokenBucket(opts: TokenBucketOptions): TokenBucket {
  const ratePerSec = opts.ratePerSec > 0 ? opts.ratePerSec : 1
  const burst = Math.max(1, opts.burst ?? Math.ceil(ratePerSec))
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? defaultSleep

  let tokens = burst
  let lastRefill = now()
  // Sentinel statt 0: die Uhr ist frei injizierbar (und Tests rechnen mit
  // kleinen Zahlen) — eine 0 wäre sonst eine echte Sperre "bis Epoch".
  let pausedUntil = Number.NEGATIVE_INFINITY
  // FIFO: jeder acquire() hängt sich hinten an die Kette — ohne diese
  // Serialisierung würden alle Waiter gleichzeitig aufwachen und den
  // Vorrat gemeinsam überziehen.
  let queue: Promise<void> = Promise.resolve()

  function refill(at: number): void {
    if (at > lastRefill) {
      tokens = Math.min(burst, tokens + ((at - lastRefill) / 1000) * ratePerSec)
      lastRefill = at
    } else if (at < lastRefill) {
      // Rückwärtssprung der Wall-Clock (NTP-Schritt, VM-Snapshot-Restore):
      // ohne Neu-Verankerung fließt bis zum Aufholen der alten Zeit KEIN
      // Token nach und jeder Waiter dreht sich durch sein Spin-Budget.
      // Der Sprung zählt als Null-Delta, danach läuft es normal weiter.
      lastRefill = at
    }
  }

  async function take(): Promise<void> {
    for (let spin = 0; spin < MAX_SPINS; spin++) {
      const at = now()
      refill(at)
      const pauseLeft = pausedUntil > at ? pausedUntil - at : 0
      if (pauseLeft > 0) {
        await sleep(pauseLeft)
        continue
      }
      if (tokens >= 1) {
        tokens -= 1
        return
      }
      await sleep(Math.max(1, Math.ceil(((1 - tokens) / ratePerSec) * 1000)))
    }
    throw new TokenBucketStalledError()
  }

  return {
    acquire() {
      const next = queue.then(take)
      // Ein Fehler eines Waiters darf die Kette nicht vergiften.
      queue = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    },
    pauseFor(ms: number) {
      if (!Number.isFinite(ms) || ms <= 0) return
      pausedUntil = Math.max(pausedUntil, now() + ms)
    },
    stats() {
      const at = now()
      refill(at)
      return {
        tokens,
        ratePerSec,
        burst,
        pausedForMs: pausedUntil > at ? pausedUntil - at : 0,
      }
    },
  }
}

interface BucketEntry {
  bucket: TokenBucket
  lastUsed: number
}

/**
 * Obergrenze der Bucket-Map: 3 Systeme × Mandanten. Der Deckel verhindert,
 * dass die Map bei sehr vielen (auch inaktiven) Mandanten unbegrenzt wächst
 * — verdrängt wird der am längsten unbenutzte Eintrag.
 */
export const MAX_BUCKETS = 600

const buckets = new Map<string, BucketEntry>()

/**
 * Bucket je (Mandant, System). Bewusst NICHT an den Client-Cache gekoppelt:
 * `invalidateTenantClients` baut nach einem Credential-Wechsel neue Clients,
 * die denselben Bucket weiterbenutzen — die Drosselung überlebt den Wechsel
 * (sonst wäre das Rate-Limit per Token-Speichern zurücksetzbar).
 *
 * LOAD-BEARING: die zurückgegebene Hülle schreibt `lastUsed` bei JEDEM
 * `acquire()`/`pauseFor()` fort. Ein Lauf holt seinen Client genau einmal
 * und feuert danach tausende Requests durch die Interceptor-Closure, ohne
 * `bucketFor` je wieder zu betreten — würde nur die Bauzeit zählen, wäre
 * ausgerechnet ein langlaufender Sync das bevorzugte Verdrängungsopfer und
 * der neu gebaute Bucket brächte einen frischen Burst samt verlorener
 * 429-Sperre mit.
 */
export function bucketFor(tenantId: string, system: RateLimitedSystem): TokenBucket {
  const key = `${tenantId} ${system}`
  const hit = buckets.get(key)
  if (hit) {
    hit.lastUsed = Date.now()
    return hit.bucket
  }

  if (buckets.size >= MAX_BUCKETS) evictOldest()

  const tuning = env.tuning(system)
  const inner = createTokenBucket({ ratePerSec: tuning.ratePerSec, burst: tuning.burst })
  const entry: BucketEntry = { bucket: inner, lastUsed: Date.now() }
  entry.bucket = {
    acquire: () => {
      entry.lastUsed = Date.now()
      return inner.acquire()
    },
    pauseFor: (ms: number) => {
      entry.lastUsed = Date.now()
      inner.pauseFor(ms)
    },
    stats: () => inner.stats(),
  }
  buckets.set(key, entry)
  return entry.bucket
}

function evictOldest(): void {
  let oldestKey: string | undefined
  let oldest = Number.POSITIVE_INFINITY
  for (const [key, entry] of buckets) {
    if (entry.lastUsed < oldest) {
      oldest = entry.lastUsed
      oldestKey = key
    }
  }
  if (oldestKey !== undefined) buckets.delete(oldestKey)
}

/** Nur für Tests. */
export function resetBucketsForTests(): void {
  buckets.clear()
}
