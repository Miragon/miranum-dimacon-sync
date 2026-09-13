import { describe, expect, it } from "vitest"
import { duplicateKeys, normalizeName } from "./matching.js"

describe("normalizeName", () => {
  it("trimmt, schreibt klein und kollabiert Mehrfach-Leerzeichen", () => {
    expect(normalizeName("  Muster   GmbH ")).toBe("muster gmbh")
    expect(normalizeName("MUSTER GMBH")).toBe("muster gmbh")
    expect(normalizeName("Muster\tGmbH")).toBe("muster gmbh")
  })

  it("liefert für undefined/null/leer den leeren String", () => {
    expect(normalizeName(undefined)).toBe("")
    expect(normalizeName(null)).toBe("")
    expect(normalizeName("   ")).toBe("")
  })
})

describe("duplicateKeys", () => {
  it("liefert nur mehrfach vorkommende Schlüssel", () => {
    const keys = duplicateKeys(
      [{ name: "Muster GmbH" }, { name: "Muster GmbH" }, { name: "Andere AG" }],
      (c) => c.name,
    )

    expect([...keys]).toEqual(["muster gmbh"])
  })

  it("ist case- und whitespace-insensitiv", () => {
    const keys = duplicateKeys(
      [{ name: "Muster GmbH" }, { name: "  muster   gmbh" }],
      (c) => c.name,
    )

    expect(keys.has("muster gmbh")).toBe(true)
  })

  it("ignoriert leere und fehlende Schlüssel", () => {
    // Regression: Kunden ohne Kundennummer dürfen nie als Duplikat gelten.
    const keys = duplicateKeys(
      [{ number: undefined }, { number: undefined }, { number: "" }, { number: "  " }],
      (c) => c.number,
    )

    expect(keys.size).toBe(0)
  })

  it("liefert jeden Duplikat-Schlüssel nur einmal, auch bei drei Vorkommen", () => {
    const keys = duplicateKeys([{ n: "a" }, { n: "a" }, { n: "a" }, { n: "b" }], (c) => c.n)

    expect([...keys]).toEqual(["a"])
  })
})
