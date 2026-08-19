import { describe, expect, it } from "vitest"
import { assertHttpUrl, isHttpUrl } from "./url.js"

describe("assertHttpUrl", () => {
  it("accepts http and https", () => {
    expect(assertHttpUrl("X", "https://api.example.com")).toBe("https://api.example.com")
    expect(assertHttpUrl("X", "http://localhost:8080")).toBe("http://localhost:8080")
  })

  it("rejects a host:port without scheme — new URL() parses it as scheme 'localhost:'", () => {
    expect(() => assertHttpUrl("DIMACON_BASE_URL", "localhost:8080")).toThrow(
      /must start with http:\/\/ or https:\/\//,
    )
  })

  it("names the offending variable and value in the message", () => {
    expect(() => assertHttpUrl("DIMACON_BASE_URL", "localhost:8080")).toThrow(
      /DIMACON_BASE_URL.*"localhost:8080"/,
    )
  })

  it("rejects a non-http scheme", () => {
    expect(() => assertHttpUrl("X", "ftp://files.example.com")).toThrow(/must start with http/)
  })

  it("rejects a value that is not a URL at all", () => {
    expect(() => assertHttpUrl("X", "not a url")).toThrow(/is not a valid URL/)
  })
})

describe("isHttpUrl", () => {
  it("mirrors assertHttpUrl as a boolean", () => {
    expect(isHttpUrl("https://x.example")).toBe(true)
    expect(isHttpUrl("localhost:8080")).toBe(false)
    expect(isHttpUrl("ftp://x")).toBe(false)
    expect(isHttpUrl("nope")).toBe(false)
  })
})
