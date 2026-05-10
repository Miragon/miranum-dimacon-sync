import { describe, expect, it } from "vitest"
import { isTransient, withRetry } from "./concurrency.js"

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
      { baseMs: 1, maxMs: 5 },
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
        { attempts: 2, baseMs: 1 },
      ),
    ).rejects.toMatchObject({ message: "Too Many Attempts." })
    expect(calls).toBe(2)
  })
})
