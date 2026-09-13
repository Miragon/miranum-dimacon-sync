import { describe, expect, it } from "vitest"
import { currentReturnTo, safeReturnTo } from "./return-to"

describe("currentReturnTo", () => {
  it("joins pathname and search", () => {
    expect(
      currentReturnTo({ pathname: "/sync/dimacon-clockin/settings", search: "?tab=credentials" }),
    ).toBe("/sync/dimacon-clockin/settings?tab=credentials")
  })

  it("works without a query string", () => {
    expect(currentReturnTo({ pathname: "/modules", search: "" })).toBe("/modules")
  })
})

describe("safeReturnTo", () => {
  it("accepts an app-internal path with query", () => {
    expect(safeReturnTo({ returnTo: "/sync/x/settings?tab=mapping" })).toBe(
      "/sync/x/settings?tab=mapping",
    )
  })

  // Der state kommt als JSON aus dem Query-String von WorkOS zurück und ist
  // damit angreifer-beeinflussbar — diese Fälle wären Open Redirects.
  it.each([
    ["absolute URL", "https://evil.example"],
    ["protocol-relative", "//evil.example"],
    ["backslash-relative", "/\\evil.example"],
    ["scheme without slash", "javascript:alert(1)"],
    ["relative path", "sync/x"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(safeReturnTo({ returnTo: value })).toBeNull()
  })

  it("rejects the root path (nothing to navigate to)", () => {
    expect(safeReturnTo({ returnTo: "/" })).toBeNull()
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string state", "/sync/x"],
    ["an empty object", {}],
    ["a non-string returnTo", { returnTo: 42 }],
  ])("rejects %s", (_label, value) => {
    expect(safeReturnTo(value)).toBeNull()
  })
})
