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

  it("handles circular objects", () => {
    const circ: Record<string, unknown> = { name: "loop" }
    circ.self = circ
    // .name not in our priority keys, falls through to JSON.stringify which throws → fallback
    expect(formatError(circ)).toBe("[unserializable error]")
  })
})
