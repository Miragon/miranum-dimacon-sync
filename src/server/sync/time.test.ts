import { describe, it, expect } from "vitest"
import { berlinOffsetForDate, splitZipCity, startDateForClockin } from "./time.js"

describe("berlinOffsetForDate", () => {
  it("returns +01:00 in winter", () => {
    expect(berlinOffsetForDate("2026-01-15")).toBe("+01:00")
    expect(berlinOffsetForDate("2026-12-15")).toBe("+01:00")
  })

  it("returns +02:00 in summer", () => {
    expect(berlinOffsetForDate("2026-07-15")).toBe("+02:00")
    expect(berlinOffsetForDate("2026-06-21")).toBe("+02:00")
  })

  it("handles DST start (last Sunday of March)", () => {
    expect(berlinOffsetForDate("2026-03-28")).toBe("+01:00")
    expect(berlinOffsetForDate("2026-03-30")).toBe("+02:00")
  })

  it("handles DST end (last Sunday of October)", () => {
    expect(berlinOffsetForDate("2026-10-24")).toBe("+02:00")
    expect(berlinOffsetForDate("2026-10-26")).toBe("+01:00")
  })
})

describe("startDateForClockin", () => {
  it("formats winter date with +01:00", () => {
    expect(startDateForClockin("2026-01-15")).toBe("2026-01-15T07:30:00+01:00")
  })

  it("formats summer date with +02:00", () => {
    expect(startDateForClockin("2026-07-15")).toBe("2026-07-15T07:30:00+02:00")
  })

  it("respects custom time of day", () => {
    expect(startDateForClockin("2026-07-15", "06:00")).toBe("2026-07-15T06:00:00+02:00")
  })
})

describe("splitZipCity", () => {
  it("splits a typical German zip+city string", () => {
    expect(splitZipCity("49565 Bramsche")).toEqual({ zip: "49565", city: "Bramsche" })
  })

  it("handles 4-digit Austrian zip", () => {
    expect(splitZipCity("1010 Wien")).toEqual({ zip: "1010", city: "Wien" })
  })

  it("returns empty zip when no number present", () => {
    expect(splitZipCity("Berlin")).toEqual({ zip: "", city: "Berlin" })
  })

  it("handles undefined", () => {
    expect(splitZipCity(undefined)).toEqual({ zip: "", city: "" })
  })

  it("handles compound city names", () => {
    expect(splitZipCity("28195 Bremen-Mitte")).toEqual({ zip: "28195", city: "Bremen-Mitte" })
  })
})
