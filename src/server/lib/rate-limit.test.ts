import { afterEach, describe, expect, it, vi } from "vitest"
import {
  bucketFor,
  createTokenBucket,
  MAX_BUCKETS,
  resetBucketsForTests,
  TokenBucketStalledError,
} from "./rate-limit.js"

/** Injizierte Uhr: `sleep` bewegt die Zeit mit, sonst dreht der Bucket leer. */
function fakeClock() {
  let t = 1_000
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
    sleeps,
  }
}

afterEach(() => {
  resetBucketsForTests()
  delete process.env.RATE_LIMIT_CLOCKIN_RPS
})

describe("createTokenBucket", () => {
  it("bedient den Burst sofort und danach exakt im Takt", async () => {
    const clock = fakeClock()
    const bucket = createTokenBucket({ ratePerSec: 2, burst: 2, ...clock })

    await bucket.acquire()
    await bucket.acquire()
    expect(clock.sleeps).toEqual([])

    await bucket.acquire()
    await bucket.acquire()
    expect(clock.sleeps).toEqual([500, 500])
  })

  it("füllt Tokens über die Zeit wieder auf (gedeckelt auf den Burst)", async () => {
    const clock = fakeClock()
    const bucket = createTokenBucket({ ratePerSec: 4, burst: 4, ...clock })

    await bucket.acquire()
    await bucket.acquire()
    clock.advance(10_000)
    expect(bucket.stats().tokens).toBe(4)

    await bucket.acquire()
    expect(clock.sleeps).toEqual([])
  })

  it("verzögert mit pauseFor alle wartenden Aufrufe", async () => {
    const clock = fakeClock()
    const bucket = createTokenBucket({ ratePerSec: 100, burst: 100, ...clock })

    bucket.pauseFor(3_000)
    expect(bucket.stats().pausedForMs).toBe(3_000)

    await bucket.acquire()
    await bucket.acquire()
    // Der erste Aufruf wartet die Sperre ab, der zweite läuft danach durch.
    expect(clock.sleeps).toEqual([3_000])
    expect(bucket.stats().pausedForMs).toBe(0)
  })

  it("ignoriert unsinnige pauseFor-Werte", () => {
    const clock = fakeClock()
    const bucket = createTokenBucket({ ratePerSec: 1, ...clock })
    bucket.pauseFor(0)
    bucket.pauseFor(Number.NaN)
    bucket.pauseFor(-5)
    expect(bucket.stats().pausedForMs).toBe(0)
  })

  it("erholt sich von einem Rückwärtssprung der Uhr", async () => {
    // NTP-Schritt / VM-Snapshot-Restore: ohne Neu-Verankerung von lastRefill
    // fließt bis zum Aufholen der alten Zeit kein Token nach.
    const clock = fakeClock()
    const bucket = createTokenBucket({ ratePerSec: 2, burst: 1, ...clock })

    await bucket.acquire()
    clock.advance(-2 * 60 * 60 * 1_000)

    await bucket.acquire()
    // Genau ein regulärer Wartevorgang (500 ms bei 2 req/s), kein Leerdrehen.
    expect(clock.sleeps).toEqual([500])
  })

  it("bricht fail-closed ab, wenn die Uhr gar nicht vorrückt", async () => {
    // Reißleine: lieber ein sichtbar gescheiterter Request als ein still
    // ungedrosselter (früher lief die Schleife aus und gab OHNE Token frei).
    const bucket = createTokenBucket({
      ratePerSec: 1,
      burst: 1,
      now: () => 0,
      sleep: async () => undefined,
    })

    await bucket.acquire()
    await expect(bucket.acquire()).rejects.toBeInstanceOf(TokenBucketStalledError)
    expect(bucket.stats().tokens).toBe(0)
  })

  it("bedient Waiter in FIFO-Reihenfolge", async () => {
    const clock = fakeClock()
    const bucket = createTokenBucket({ ratePerSec: 1, burst: 1, ...clock })

    const order: number[] = []
    const waiters = [0, 1, 2, 3].map((i) => bucket.acquire().then(() => order.push(i)))
    await Promise.all(waiters)

    expect(order).toEqual([0, 1, 2, 3])
  })
})

describe("bucketFor", () => {
  it("liefert je (Mandant, System) eine eigene Instanz", () => {
    const a1 = bucketFor("tenant-a", "clockin")
    const a2 = bucketFor("tenant-a", "clockin")
    const b = bucketFor("tenant-b", "clockin")
    const aDimacon = bucketFor("tenant-a", "dimacon")

    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1).not.toBe(aDimacon)
  })

  it("übernimmt die Env-Overrides beim Anlegen", () => {
    process.env.RATE_LIMIT_CLOCKIN_RPS = "1"
    expect(bucketFor("tenant-c", "clockin").stats().ratePerSec).toBe(1)
  })

  it("verdrängt nach tatsächlicher Benutzung, nicht nach Bauzeit", async () => {
    // Ein Lauf holt seinen Client EINMAL und feuert danach durch die
    // Interceptor-Closure — ohne lastUsed-Fortschreibung im acquire() wäre
    // ausgerechnet der laufende Sync das älteste (= verdrängte) Element.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T10:00:00Z"))
      const laufend = bucketFor("tenant-laufend", "dimacon")
      const untaetig = bucketFor("tenant-untaetig", "dimacon")

      // Die Map bis zum Deckel füllen; alle Füller sind jünger als beide oben.
      vi.setSystemTime(new Date("2026-01-01T10:03:00Z"))
      for (let i = 0; i < MAX_BUCKETS - 2; i++) bucketFor(`filler-${i}`, "clockin")

      // Der laufende Mandant feuert weiter — nur über acquire(), nie über
      // bucketFor (den Client hält er längst).
      vi.setSystemTime(new Date("2026-01-01T10:20:00Z"))
      await laufend.acquire()

      // Ein neuer Mandant sprengt den Deckel und löst die Verdrängung aus.
      bucketFor("tenant-neu", "lexoffice")

      expect(bucketFor("tenant-laufend", "dimacon")).toBe(laufend)
      expect(bucketFor("tenant-untaetig", "dimacon")).not.toBe(untaetig)
    } finally {
      vi.useRealTimers()
    }
  })

  it("behält die 429-Sperre über den Client-Neubau hinweg", () => {
    const bucket = bucketFor("tenant-d", "dimacon")
    bucket.pauseFor(30_000)
    // invalidateTenantClients baut neue Clients — der Bucket bleibt derselbe.
    expect(bucketFor("tenant-d", "dimacon").stats().pausedForMs).toBeGreaterThan(0)
  })
})
