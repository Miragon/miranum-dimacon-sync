import { describe, expect, it } from "vitest"
import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import {
  CREATION_DISABLED_REASON,
  INCOMPLETE_BASE_REASON,
  buildLooseNameIndex,
  creationBlockReason,
  looseNameKey,
} from "./creation-policy.js"
import type { CreationPolicyInput } from "./creation-policy.js"
import type { ClockinEmployeeInfo } from "./types.js"

function clk(overrides: Partial<ClockinEmployeeInfo> = {}): ClockinEmployeeInfo {
  return {
    id: 1,
    firstName: "Anna",
    lastName: "Muster",
    personnelNumber: "P-1",
    ...overrides,
  }
}

function dim(overrides: Partial<DimaconEmployeeFull> = {}): DimaconEmployeeFull {
  return {
    id: "d1",
    firstName: "Anna",
    lastName: "Muster",
    role: "CRAFTSMAN",
    color: "#A1A1AA",
    timeTrackingActive: true,
    isArchived: false,
    ...overrides,
  }
}

function policy(overrides: Partial<CreationPolicyInput> = {}): CreationPolicyInput {
  return {
    enabled: true,
    baseComplete: true,
    blocked: new Map(),
    looseNames: new Map(),
    today: "2026-09-10",
    ...overrides,
  }
}

describe("looseNameKey", () => {
  it("ignores hyphens, second given names and casing", () => {
    expect(looseNameKey("Hans-Peter", "Meier")).toBe(looseNameKey("Hans Peter", "Meier"))
    expect(looseNameKey("Anna Maria", "Muster")).toBe(looseNameKey("anna", "Muster"))
    expect(looseNameKey("  Anna  ", "Muster ")).toBe("anna muster")
  })

  it("normalises umlauts and eszett to their spelled-out form", () => {
    expect(looseNameKey("Hans", "Müller")).toBe(looseNameKey("Hans", "Mueller"))
    expect(looseNameKey("Hans", "Weiß")).toBe(looseNameKey("Hans", "Weiss"))
    expect(looseNameKey("Jörg", "Öztürk")).toBe(looseNameKey("Joerg", "Oeztuerk"))
    // sonstige Diakritika werden gestrippt, nicht ausgeschrieben
    expect(looseNameKey("José", "Muster")).toBe("jose muster")
  })

  it("keeps different names apart and yields an empty key without a name", () => {
    expect(looseNameKey("Hans", "Meier")).not.toBe(looseNameKey("Hans", "Müller"))
    expect(looseNameKey("Hans", "")).toBe("")
    expect(looseNameKey(undefined, "Meier")).toBe("")
    expect(looseNameKey("123", "456")).toBe("")
  })

  it("indexes dimacon employees by their loose key, first hit wins", () => {
    const index = buildLooseNameIndex([
      dim({ id: "d1", firstName: "Hans-Peter", lastName: "Müller" }),
      dim({ id: "d2", firstName: "Hans Peter", lastName: "Mueller" }),
      dim({ id: "d3", firstName: "", lastName: "" }),
    ])

    expect(index.size).toBe(1)
    expect(index.get(looseNameKey("Hans", "Müller"))).toBe("Hans-Peter Müller")
  })
})

describe("creationBlockReason", () => {
  it("allows a complete candidate with a personnel number", () => {
    expect(creationBlockReason(clk(), policy())).toBeNull()
  })

  it("blocks everything while the step is disabled", () => {
    expect(creationBlockReason(clk(), policy({ enabled: false }))).toBe(CREATION_DISABLED_REASON)
  })

  it("blocks everything while the clockin base is incomplete", () => {
    expect(creationBlockReason(clk(), policy({ baseComplete: false }))).toBe(INCOMPLETE_BASE_REASON)
  })

  it("passes the matcher reason through for blocked ids", () => {
    const blocked = new Map([[1, "Dublette in Clockin zu bereits zugeordnetem Datensatz #9"]])
    expect(creationBlockReason(clk(), policy({ blocked }))).toContain("Dublette")
  })

  it("blocks incomplete names", () => {
    expect(creationBlockReason(clk({ lastName: "  " }), policy())).toBe(
      "unvollständiger Name in Clockin",
    )
  })

  it("blocks candidates without a personnel number", () => {
    expect(creationBlockReason(clk({ personnelNumber: "   " }), policy())).toContain(
      "keine Personalnummer",
    )
  })

  it("blocks contracts that ended before today, but not future ones", () => {
    expect(creationBlockReason(clk({ contractEnding: "2026-08-31" }), policy())).toBe(
      "Vertrag endete am 2026-08-31",
    )
    expect(creationBlockReason(clk({ contractEnding: "2026-09-10" }), policy())).toBeNull()
    expect(creationBlockReason(clk({ contractEnding: "2026-12-31T00:00:00" }), policy())).toBeNull()
  })

  it("blocks candidates with a similar name in dimacon", () => {
    const looseNames = buildLooseNameIndex([dim({ firstName: "Hans Peter", lastName: "Mueller" })])
    const reason = creationBlockReason(
      clk({ firstName: "Hans-Peter", lastName: "Müller" }),
      policy({ looseNames }),
    )

    expect(reason).toContain("ähnlicher Name in Dimacon vorhanden (Hans Peter Mueller)")
  })

  it("applies the rules in order — the disabled switch beats every other reason", () => {
    const candidate = clk({ firstName: "", lastName: "", personnelNumber: undefined })
    const blocked = new Map([[1, "mehrdeutige Zuordnung zu Anna Muster über name"]])

    expect(creationBlockReason(candidate, policy({ enabled: false, blocked }))).toBe(
      CREATION_DISABLED_REASON,
    )
    expect(creationBlockReason(candidate, policy({ baseComplete: false, blocked }))).toBe(
      INCOMPLETE_BASE_REASON,
    )
    expect(creationBlockReason(candidate, policy({ blocked }))).toContain("mehrdeutige Zuordnung")
    expect(creationBlockReason(candidate, policy())).toBe("unvollständiger Name in Clockin")
  })
})
