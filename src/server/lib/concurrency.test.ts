import { describe, expect, it } from "vitest"
import { isRateLimited, isTransient, withRetry } from "./concurrency.js"

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
