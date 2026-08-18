import { afterEach, describe, expect, it } from "vitest"
import { env } from "./env.js"

const ORIGINAL = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL }
})

describe("env base URLs", () => {
  it("accepts http and https", () => {
    process.env.DIMACON_BASE_URL = "https://api.example.com"
    expect(env.dimacon.baseUrl()).toBe("https://api.example.com")

    process.env.DIMACON_BASE_URL = "http://localhost:8080"
    expect(env.dimacon.baseUrl()).toBe("http://localhost:8080")
  })

  it("rejects a host:port without scheme — new URL() parses it as scheme 'localhost:'", () => {
    process.env.DIMACON_BASE_URL = "localhost:8080"
    expect(() => env.dimacon.baseUrl()).toThrow(/must start with http:\/\/ or https:\/\//)
  })

  it("names the offending variable and value in the message", () => {
    process.env.DIMACON_BASE_URL = "localhost:8080"
    expect(() => env.dimacon.baseUrl()).toThrow(/DIMACON_BASE_URL.*"localhost:8080"/)
  })

  it("rejects a non-http scheme", () => {
    process.env.DIMACON_BASE_URL = "ftp://files.example.com"
    expect(() => env.dimacon.baseUrl()).toThrow(/must start with http/)
  })

  it("rejects a value that is not a URL at all", () => {
    process.env.DIMACON_BASE_URL = "not a url"
    expect(() => env.dimacon.baseUrl()).toThrow(/is not a valid URL/)
  })

  it("still reports a missing required variable", () => {
    delete process.env.DIMACON_BASE_URL
    expect(() => env.dimacon.baseUrl()).toThrow(/Missing required env var: DIMACON_BASE_URL/)
  })

  it("treats an unset optional base URL as undefined but validates a set one", () => {
    delete process.env.CLOCKIN_BASE_URL
    expect(env.clockin.baseUrl()).toBeUndefined()

    process.env.CLOCKIN_BASE_URL = "clockin.de"
    expect(() => env.clockin.baseUrl()).toThrow(/CLOCKIN_BASE_URL/)
  })
})
