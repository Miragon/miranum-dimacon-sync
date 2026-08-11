import { describe, expect, it } from "vitest"
import { formatError } from "./errors.js"

describe("formatError", () => {
  it("handles Error instances", () => {
    expect(formatError(new Error("kaboom"))).toBe("kaboom")
  })

  it("falls back to Error.name when message is empty", () => {
    expect(formatError(new TypeError(""))).toBe("TypeError")
  })

  it("returns strings unchanged", () => {
    expect(formatError("plain string")).toBe("plain string")
  })

  it("handles null and undefined", () => {
    expect(formatError(null)).toBe("unknown error")
    expect(formatError(undefined)).toBe("unknown error")
  })

  it("extracts .message from plain objects", () => {
    expect(formatError({ message: "from API" })).toBe("from API")
  })

  it("extracts nested error.message", () => {
    expect(formatError({ error: { message: "nested" } })).toBe("nested")
  })

  it("extracts string .error field", () => {
    expect(formatError({ error: "shorthand" })).toBe("shorthand")
  })

  it("formats Lexware IssueList shape", () => {
    const lexErr = {
      IssueList: [{ type: "totalAmountMismatch", argument: "lineItems" }],
    }
    expect(formatError(lexErr)).toBe("totalAmountMismatch: lineItems")
  })

  it("formats HTTP status shape", () => {
    expect(formatError({ status: 422, statusText: "Unprocessable Entity" })).toBe(
      "HTTP 422 Unprocessable Entity",
    )
  })

  it("falls back to JSON.stringify for unknown shape", () => {
    expect(formatError({ foo: 1, bar: 2 })).toBe('{"foo":1,"bar":2}')
  })

  it("never produces [object Object]", () => {
    expect(formatError({})).not.toBe("[object Object]")
    expect(formatError({ random: "stuff" })).not.toContain("[object Object]")
  })

  it("caps very long messages", () => {
    const huge = "x".repeat(2000)
    const out = formatError(huge)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out.endsWith("…")).toBe(true)
  })

  it("appends an undici-shaped cause code", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    })
    expect(formatError(err)).toBe("fetch failed (ECONNREFUSED)")
  })

  it("appends a cause message when no code is present", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: new Error("unknown scheme"),
    })
    expect(formatError(err)).toBe("fetch failed (unknown scheme)")
  })

  it("prefers a non-empty cause message over an empty code", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "", message: "socket hang up" },
    })
    expect(formatError(err)).toBe("fetch failed (socket hang up)")
  })

  it("walks a nested cause chain", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { message: "", cause: { code: "ENOTFOUND" } },
    })
    expect(formatError(err)).toBe("fetch failed (ENOTFOUND)")
  })

  it("stops descending after the depth cutoff", () => {
    // 6 levels deep — beyond the depth-5 cutoff, so the code is never reached.
    let cause: Record<string, unknown> = { code: "DEEP" }
    for (let i = 0; i < 6; i++) cause = { cause }
    const err = Object.assign(new TypeError("fetch failed"), { cause })
    expect(formatError(err)).toBe("fetch failed")
  })

  it("does not append a cause already contained in the message", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
      cause: { code: "ECONNREFUSED" },
    })
    expect(formatError(err)).toBe("connect ECONNREFUSED 127.0.0.1:8080")
  })

  it("ignores a cause with no usable code or message", () => {
    const err = Object.assign(new Error("boom"), { cause: { foo: 1 } })
    expect(formatError(err)).toBe("boom")
  })

  it("handles circular objects", () => {
    const circ: Record<string, unknown> = { name: "loop" }
    circ.self = circ
    // .name not in our priority keys, falls through to JSON.stringify which throws → fallback
    expect(formatError(circ)).toBe("[unserializable error]")
  })
})
