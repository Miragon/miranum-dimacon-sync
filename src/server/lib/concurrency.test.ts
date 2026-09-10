import { afterEach, describe, expect, it } from "vitest"
import {
  createLimit,
  isRateLimited,
  isTransient,
  NO_RATE_LIMIT_RETRY,
  NON_IDEMPOTENT_RETRY,
  retryAfterMs,
  withRetry,
} from "./concurrency.js"
import { enrichClientError } from "./client-instrumentation.js"
import { withRunMetrics, type RunMetricsSnapshot } from "./metrics.js"

const emptyHeaders = { get: () => null }

describe("isTransient", () => {
  it("recognizes status field 429", () => {
    expect(isTransient({ status: 429, message: "boom" })).toBe(true)
  })

  it("recognizes status field 5xx", () => {
    expect(isTransient({ status: 503 })).toBe(true)
    expect(isTransient({ status: 500 })).toBe(true)
  })

  it("does not retry on 4xx other than 429", () => {
    expect(isTransient({ status: 400 })).toBe(false)
    expect(isTransient({ status: 422 })).toBe(false)
  })

  it("recognizes 'Too Many Attempts.' (Laravel throttle)", () => {
    expect(isTransient({ message: "Too Many Attempts." })).toBe(true)
  })

  it("recognizes 'Too Many Requests'", () => {
    expect(isTransient({ message: "Too Many Requests" })).toBe(true)
  })

  it("recognizes 'rate limit exceeded'", () => {
    expect(isTransient({ message: "Rate limit exceeded" })).toBe(true)
    expect(isTransient({ message: "rateLimitExceeded" })).toBe(true)
  })

  it("recognizes throttle phrases", () => {
    expect(isTransient({ message: "Request throttled" })).toBe(true)
  })

  it("recognizes 429 / 5xx in error message string", () => {
    expect(isTransient({ message: "Lexoffice API 429: ..." })).toBe(true)
    expect(isTransient({ message: "Lexoffice API 503: ..." })).toBe(true)
  })

  it("works on plain string errors", () => {
    expect(isTransient("Too Many Attempts.")).toBe(true)
    expect(isTransient("ok")).toBe(false)
  })

  it("recognizes ECONNRESET / ETIMEDOUT / EAI_AGAIN", () => {
    expect(isTransient({ code: "ECONNRESET" })).toBe(true)
    expect(isTransient({ code: "ETIMEDOUT" })).toBe(true)
    expect(isTransient({ code: "EAI_AGAIN" })).toBe(true)
  })

  it("returns false for null / non-objects", () => {
    expect(isTransient(null)).toBe(false)
    expect(isTransient(undefined)).toBe(false)
    expect(isTransient(42)).toBe(false)
  })

  it("unwraps undici 'fetch failed' with a network code in cause", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    })
    expect(isTransient(err)).toBe(true)
  })

  it("unwraps a nested cause chain", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { message: "", cause: { code: "ECONNRESET" } },
    })
    expect(isTransient(err)).toBe(true)
  })

  it("recognizes undici UND_ERR_* codes", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    })
    expect(isTransient(err)).toBe(true)
  })

  it("recognizes 'socket hang up' in a cause message", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: new Error("socket hang up"),
    })
    expect(isTransient(err)).toBe(true)
  })

  it("does not retry a fetch TypeError with a non-transient cause", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ERR_INVALID_URL" },
    })
    expect(isTransient(err)).toBe(false)
  })
})

describe("isRateLimited", () => {
  it("recognizes throttle messages and status 429", () => {
    expect(isRateLimited({ message: "Too Many Attempts." })).toBe(true)
    expect(isRateLimited({ status: 429 })).toBe(true)
    expect(isRateLimited("rate limit exceeded")).toBe(true)
  })

  it("is false for network errors and other statuses", () => {
    expect(isRateLimited({ code: "ECONNRESET" })).toBe(false)
    expect(isRateLimited({ status: 503 })).toBe(false)
    expect(isRateLimited(null)).toBe(false)
  })
})

describe("withRetry", () => {
  it("returns the value when fn succeeds first try", async () => {
    const fn = async () => 42
    expect(await withRetry(fn)).toBe(42)
  })

  it("retries on transient errors and eventually succeeds", async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw { message: "Too Many Attempts." }
        return "ok"
      },
      { baseMs: 1, maxMs: 5, rateLimitWaitMs: 1 },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })

  it("does not retry on permanent errors", async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw { status: 422, message: "Unprocessable" }
        },
        { baseMs: 1 },
      ),
    ).rejects.toMatchObject({ status: 422 })
    expect(calls).toBe(1)
  })

  it("gives up after the configured attempts", async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw { message: "Too Many Attempts." }
        },
        { attempts: 2, baseMs: 1, rateLimitWaitMs: 1 },
      ),
    ).rejects.toMatchObject({ message: "Too Many Attempts." })
    expect(calls).toBe(2)
  })

  it("waits rateLimitWaitMs (not exponential backoff) for throttle errors", async () => {
    const waits: number[] = []
    let calls = 0
    await withRetry(
      async () => {
        calls++
        if (calls < 3) throw { message: "Too Many Attempts." }
        return "ok"
      },
      {
        baseMs: 1,
        rateLimitWaitMs: 77,
        sleep: async (ms) => {
          waits.push(ms)
        },
      },
    )
    expect(waits).toEqual([77, 77])
  })

  it("uses exponential backoff for network errors", async () => {
    const waits: number[] = []
    let calls = 0
    await withRetry(
      async () => {
        calls++
        if (calls < 4)
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
        return "ok"
      },
      {
        baseMs: 1,
        maxMs: 100,
        sleep: async (ms) => {
          waits.push(ms)
        },
      },
    )
    expect(waits).toEqual([1, 2, 4])
  })
})

describe("retryAfterMs", () => {
  it("liest den Wert aus dem Fehler und aus der cause-Kette", () => {
    expect(retryAfterMs({ status: 429, retryAfterMs: 3_000 })).toBe(3_000)
    expect(retryAfterMs(Object.assign(new Error("x"), { cause: { retryAfterMs: 1_500 } }))).toBe(
      1_500,
    )
  })

  it("deckelt auf 60 s und ignoriert Unsinn", () => {
    expect(retryAfterMs({ retryAfterMs: 300_000 })).toBe(60_000)
    expect(retryAfterMs({ retryAfterMs: "5" })).toBeUndefined()
    expect(retryAfterMs({ retryAfterMs: -1 })).toBeUndefined()
    expect(retryAfterMs(null)).toBeUndefined()
  })

  it("wertet 0 nicht als Server-Angabe (sonst entfiele jede Wartezeit)", () => {
    expect(retryAfterMs({ status: 429, retryAfterMs: 0 })).toBeUndefined()
  })
})

describe("withRetry — Rate-Limit-Wartezeiten", () => {
  it("wartet exakt das Retry-After des Servers", async () => {
    const waits: number[] = []
    let calls = 0
    await withRetry(
      async () => {
        calls++
        if (calls < 2) throw { status: 429, retryAfterMs: 3_000, message: "Too Many Requests" }
        return "ok"
      },
      {
        sleep: async (ms) => {
          waits.push(ms)
        },
      },
    )
    expect(waits).toEqual([3_000])
  })

  it("deckelt ein überlanges Retry-After auf 60 s", async () => {
    const waits: number[] = []
    let calls = 0
    await withRetry(
      async () => {
        calls++
        if (calls < 2) throw { status: 429, retryAfterMs: 900_000 }
        return "ok"
      },
      {
        sleep: async (ms) => {
          waits.push(ms)
        },
      },
    )
    expect(waits).toEqual([60_000])
  })

  it("staffelt ohne Retry-After 5/10/20 s statt pauschal 20 s", async () => {
    const waits: number[] = []
    await expect(
      withRetry(
        async () => {
          throw { status: 429, message: "Too Many Attempts." }
        },
        {
          attempts: 4,
          sleep: async (ms) => {
            waits.push(ms)
          },
        },
      ),
    ).rejects.toMatchObject({ status: 429 })

    expect(waits).toHaveLength(3)
    // ±20 % Jitter um 5/10/20 s — und nie die alte 20-s-Pauschale als Erstes.
    expect(waits[0]).toBeGreaterThanOrEqual(4_000)
    expect(waits[0]).toBeLessThanOrEqual(6_000)
    expect(waits[1]).toBeGreaterThanOrEqual(8_000)
    expect(waits[1]).toBeLessThanOrEqual(12_000)
    expect(waits[2]).toBeGreaterThanOrEqual(16_000)
    expect(waits[2]).toBeLessThanOrEqual(24_000)
  })

  it("meldet Wartezeiten an die Lauf-Metrik", async () => {
    let snapshot: RunMetricsSnapshot | undefined
    await withRunMetrics(
      async () => {
        let calls = 0
        await withRetry(
          async () => {
            calls++
            if (calls < 2) throw { status: 429, retryAfterMs: 2_000 }
            return "ok"
          },
          { sleep: async () => undefined },
        )
      },
      (s) => (snapshot = s),
    )
    expect(snapshot).toMatchObject({ retries: 1, rateLimited: 1, waitedMs: 2_000 })
  })
})

describe("Retry-After ⊕ Interceptor (Kompositionspfad)", () => {
  /** Der Weg, den ein echter 429 nimmt: Response → Interceptor → withRetry. */
  async function waitsFor(headers: Record<string, string>, nowMs: number): Promise<number[]> {
    const waits: number[] = []
    const response = {
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    }
    await expect(
      withRetry(
        async () => {
          throw enrichClientError({ message: "Too Many Attempts." }, response, undefined, nowMs)
        },
        {
          attempts: 3,
          sleep: async (ms) => {
            waits.push(ms)
          },
        },
      ),
    ).rejects.toMatchObject({ status: 429 })
    return waits
  }

  const now = Date.parse("2026-01-01T12:00:00Z")

  it("wartet die Staffel, wenn Retry-After in der Vergangenheit liegt", async () => {
    // Uhr-Drift: der Server meint "warte 60 s", unsere Uhr geht 60 s vor.
    const waits = await waitsFor({ "retry-after": "Thu, 01 Jan 2026 11:59:00 GMT" }, now)
    expect(waits).toHaveLength(2)
    expect(waits[0]).toBeGreaterThanOrEqual(4_000)
    expect(waits[1]).toBeGreaterThanOrEqual(8_000)
  })

  it("wartet die Staffel bei Retry-After: 0", async () => {
    const waits = await waitsFor({ "retry-after": "0" }, now)
    expect(waits).toHaveLength(2)
    expect(waits[0]).toBeGreaterThanOrEqual(4_000)
  })

  it("wartet weiterhin exakt einen brauchbaren Retry-After-Wert", async () => {
    expect(await waitsFor({ "retry-after": "4" }, now)).toEqual([4_000, 4_000])
  })
})

describe("NON_IDEMPOTENT_RETRY", () => {
  it("wiederholt einen 5xx NICHT (der Datensatz kann schon angelegt sein)", async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        // Laravel-Fehlerbody ohne Statuszahl, angereichert vom Interceptor.
        throw enrichClientError({ message: "Server Error" }, { status: 500, headers: emptyHeaders })
      }, NON_IDEMPOTENT_RETRY),
    ).rejects.toMatchObject({ status: 500 })
    expect(calls).toBe(1)
  })

  it("wiederholt auch Verbindungsabbrüche nicht", async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
      }, NON_IDEMPOTENT_RETRY),
    ).rejects.toThrow("fetch failed")
    expect(calls).toBe(1)
  })

  it("wiederholt ein Rate-Limit (vom Zielsystem nachweislich nicht verarbeitet)", async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw { status: 429, retryAfterMs: 1_000 }
        return "ok"
      },
      { ...NON_IDEMPOTENT_RETRY, sleep: async () => undefined },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })
})

describe("NO_RATE_LIMIT_RETRY", () => {
  it("wirft 429 sofort durch (der Lexware-Client retryt selbst)", async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw { message: "Lexoffice API 429: Too many requests" }
      }, NO_RATE_LIMIT_RETRY),
    ).rejects.toMatchObject({ message: expect.stringContaining("429") })
    expect(calls).toBe(1)
  })

  it("erkennt den Lexware-429 auch ohne Rate-Limit-Phrase im Body", async () => {
    // Der Lexware-Client wirft einen nackten Error ohne status-Feld; der Body
    // muss keine Throttle-Formulierung enthalten.
    const err = new Error('Lexoffice API 429: {"message":"blockiert"}')
    expect(isRateLimited(err)).toBe(true)

    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw err
      }, NO_RATE_LIMIT_RETRY),
    ).rejects.toThrow("429")
    expect(calls).toBe(1)
  })

  it("retryt weiterhin Netzwerkfehler", async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw { code: "ECONNRESET" }
        return "ok"
      },
      { ...NO_RATE_LIMIT_RETRY, sleep: async () => undefined },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })
})

describe("createLimit", () => {
  afterEach(() => {
    delete process.env.CONCURRENCY_LEXOFFICE
  })

  it("nutzt ohne System die bisherige globale 3", () => {
    expect(createLimit().concurrency).toBe(3)
  })

  it("nutzt die System-Defaults und Env-Overrides", () => {
    expect(createLimit("lexoffice").concurrency).toBe(2)
    expect(createLimit("dimacon").concurrency).toBe(8)
    process.env.CONCURRENCY_LEXOFFICE = "4"
    expect(createLimit("lexoffice").concurrency).toBe(4)
  })
})
