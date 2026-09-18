import { describe, expect, it } from "vitest"
import type { DimaconEmployeeFull } from "../../shared/dimacon.js"
import {
  CREATION_DISABLED_REASON,
  INCOMPLETE_BASE_REASON,
  buildClockinCreationPolicy,
  buildLooseNameIndex,
  clockinCreationBlockReason,
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

describe("clockinCreationBlockReason (Anlage Dimacon → Clockin)", () => {
  /** Policy wie im Lauf: aus Kandidaten, ungepaarten und allen Clockin-Datensätzen */
  function reasonFor(
    candidate: DimaconEmployeeFull,
    context: {
      otherCandidates?: DimaconEmployeeFull[]
      unpaired?: ClockinEmployeeInfo[]
      allClockin?: ClockinEmployeeInfo[]
    } = {},
  ) {
    const unpaired = context.unpaired ?? []
    const p = buildClockinCreationPolicy(
      { dimaconOnly: [candidate, ...(context.otherCandidates ?? [])], clockinOnly: unpaired },
      context.allClockin ?? unpaired,
    )
    return clockinCreationBlockReason(candidate, p)
  }

  it("allows a real person with a new personnel number", () => {
    expect(reasonFor(dim({ personnelNumber: "00077" }))).toBeNull()
  })

  it("blocks placeholder records without a letter in a name part", () => {
    expect(reasonFor(dim({ firstName: "Subunternehmer", lastName: "!" }))).toBe(
      "kein vollständiger Personenname in Dimacon (Platzhalter?)",
    )
  })

  it("accepts names in any script", () => {
    expect(
      reasonFor(dim({ firstName: "Иван", lastName: "Петров", personnelNumber: "9" })),
    ).toBeNull()
  })

  it("blocks records without a personnel number", () => {
    expect(reasonFor(dim({ firstName: "Daniel", lastName: "Alt" }))).toBe(
      "keine Personalnummer in Dimacon — ohne sie ist keine eindeutige Zuordnung möglich",
    )
  })

  it("points to the clockin twin when the personnel number is missing in dimacon", () => {
    expect(reasonFor(dim(), { unpaired: [clk({ id: 7, personnelNumber: "00030" })] })).toBe(
      "keine Personalnummer in Dimacon — in Clockin steht Anna Muster #7, PNr 00030; Personalnummer in Dimacon pflegen",
    )
  })

  it("blocks a personnel number that another clockin record already carries", () => {
    const holder = clk({ id: 3, firstName: "Bo", lastName: "Z", personnelNumber: "P-5" })
    expect(reasonFor(dim({ personnelNumber: "p-5" }), { allClockin: [holder] })).toBe(
      "Personalnummer p-5 ist in Clockin bereits vergeben (Bo Z #3, PNr P-5)",
    )
  })

  it("blocks a personnel number that occurs twice among the candidates", () => {
    const twin = dim({ id: "d2", firstName: "Bo", lastName: "Z", personnelNumber: "P-5" })
    expect(reasonFor(dim({ personnelNumber: "P-5" }), { otherCandidates: [twin] })).toBe(
      "Personalnummer P-5 ist in Dimacon mehrfach vergeben",
    )
  })

  it("blocks a similar name in clockin under a different personnel number", () => {
    const twin = clk({ id: 7, personnelNumber: "00030" })
    expect(reasonFor(dim({ personnelNumber: "30" }), { unpaired: [twin] })).toBe(
      "ähnlicher Name in Clockin vorhanden (Anna Muster #7, PNr 00030) — Personalnummern abgleichen",
    )
  })

  it("ignores namesakes that are already paired in clockin", () => {
    // Gepaarte Clockin-Datensätze gehören per PNr zu einer ANDEREN Person —
    // ein Namensvetter mit neuer Nummer darf angelegt werden.
    const paired = clk({ id: 7, personnelNumber: "P-1" })
    expect(reasonFor(dim({ personnelNumber: "P-2" }), { allClockin: [paired] })).toBeNull()
  })
})
