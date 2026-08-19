import { describe, expect, it } from "vitest"
import {
  ALL_DAYS,
  cronToSpec,
  DEFAULT_SPEC,
  describeSpec,
  specToCron,
  WEEKDAYS,
} from "./schedule-cron"

describe("specToCron", () => {
  it("renders daily with all days as *", () => {
    expect(specToCron({ mode: "daily", hour: 6, minute: 0, days: ALL_DAYS })).toBe("0 6 * * *")
  })

  it("collapses exactly Mo–Fr to 1-5", () => {
    expect(specToCron({ mode: "daily", hour: 6, minute: 30, days: WEEKDAYS })).toBe("30 6 * * 1-5")
  })

  it("renders other day sets as a sorted comma list including sunday=0", () => {
    expect(specToCron({ mode: "daily", hour: 8, minute: 15, days: [0, 3, 1] })).toBe(
      "15 8 * * 0,1,3",
    )
  })

  it("renders minute intervals as */N", () => {
    expect(specToCron({ mode: "interval", unit: "minutes", every: 15 })).toBe("*/15 * * * *")
  })

  it("renders hourly as 0 * * * * and multi-hour as 0 */N", () => {
    expect(specToCron({ mode: "interval", unit: "hours", every: 1 })).toBe("0 * * * *")
    expect(specToCron({ mode: "interval", unit: "hours", every: 6 })).toBe("0 */6 * * *")
  })

  it("passes expert crons through verbatim", () => {
    expect(specToCron({ mode: "expert", cron: "13 */2 * * *" })).toBe("13 */2 * * *")
  })
})

describe("cronToSpec", () => {
  it("round-trips daily specs", () => {
    const cases: { mode: "daily"; hour: number; minute: number; days: number[] }[] = [
      { mode: "daily", hour: 6, minute: 0, days: ALL_DAYS },
      { mode: "daily", hour: 23, minute: 55, days: WEEKDAYS },
      { mode: "daily", hour: 0, minute: 5, days: [0, 6] },
    ]
    for (const spec of cases) {
      const parsed = cronToSpec(specToCron(spec))
      expect(parsed.mode).toBe("daily")
      if (parsed.mode === "daily") {
        expect(parsed.hour).toBe(spec.hour)
        expect(parsed.minute).toBe(spec.minute)
        expect([...parsed.days].sort()).toEqual([...spec.days].sort())
      }
    }
  })

  it("parses 1-5 ranges and comma lists", () => {
    expect(cronToSpec("0 6 * * 1-5")).toEqual({ mode: "daily", hour: 6, minute: 0, days: WEEKDAYS })
    expect(cronToSpec("0 6 * * 0,6")).toEqual({ mode: "daily", hour: 6, minute: 0, days: [0, 6] })
  })

  it("round-trips curated intervals", () => {
    expect(cronToSpec("*/15 * * * *")).toEqual({ mode: "interval", unit: "minutes", every: 15 })
    expect(cronToSpec("0 * * * *")).toEqual({ mode: "interval", unit: "hours", every: 1 })
    expect(cronToSpec("0 */12 * * *")).toEqual({ mode: "interval", unit: "hours", every: 12 })
  })

  it("sends non-curated or non-picker patterns to expert mode", () => {
    for (const cron of [
      "*/7 * * * *", // kein kuratierter Teiler
      "13 */2 * * *", // Minute ≠ 0 bei Stunden-Intervall
      "0 6 1 * *", // Monatstag gesetzt
      "0 6 * 2 *", // Monat gesetzt
      "0 6 * * 5-1", // Wrap-around-Range
      "0 6 * * 7", // 7 ist kein gültiger Picker-Tag (nur 0–6)
      "*/5 9-17 * * *", // kombiniert
      "0 0 * * * *", // 6 Felder
      "60 6 * * *", // Minute außerhalb
    ]) {
      expect(cronToSpec(cron)).toEqual({ mode: "expert", cron })
    }
  })

  it("falls back to the default spec when no cron is set", () => {
    expect(cronToSpec(undefined)).toEqual(DEFAULT_SPEC)
    expect(cronToSpec("  ")).toEqual(DEFAULT_SPEC)
  })
})

describe("describeSpec", () => {
  it("describes daily specs with day annotations", () => {
    expect(describeSpec({ mode: "daily", hour: 6, minute: 0, days: ALL_DAYS })).toBe(
      "Täglich um 06:00",
    )
    expect(describeSpec({ mode: "daily", hour: 6, minute: 0, days: WEEKDAYS })).toBe(
      "Täglich um 06:00 (Mo–Fr)",
    )
    expect(describeSpec({ mode: "daily", hour: 9, minute: 30, days: [6, 0] })).toBe(
      "Täglich um 09:30 (Sa, So)",
    )
  })

  it("describes intervals", () => {
    expect(describeSpec({ mode: "interval", unit: "minutes", every: 5 })).toBe("Alle 5 Minuten")
    expect(describeSpec({ mode: "interval", unit: "hours", every: 1 })).toBe("Stündlich")
    expect(describeSpec({ mode: "interval", unit: "hours", every: 4 })).toBe("Alle 4 Stunden")
  })
})
