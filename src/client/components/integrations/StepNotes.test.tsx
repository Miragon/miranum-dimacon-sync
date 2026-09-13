// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { StepNotes } from "./bits"
import { RUN_SCOPE_SPECS } from "#/lib/run-scope"

afterEach(cleanup)

describe("StepNotes", () => {
  /**
   * Kern der Komponente: Die Bedingungen eines Schritts müssen sichtbar sein,
   * BEVOR man ihn einschaltet. Ein zustandsabhängiger Hinweis erklärt den
   * Filter erst, wenn die Entscheidung schon gefallen ist — und wer die Regel
   * nie zu sehen bekommt, hält die übersprungenen Kandidaten im Ergebnis für
   * einen Fehler des Syncs.
   */
  it("zeigt die Bedingungen unabhängig vom Schaltzustand", () => {
    render(<StepNotes steps={RUN_SCOPE_SPECS["dimacon-clockin"]!.steps} />)

    // Der Schritt ist per Default AUS (Issue #17) — die Regel steht trotzdem da.
    expect(screen.getByText("Mitarbeiter in Dimacon anlegen")).toBeTruthy()
    expect(screen.getByText(/nur Clockin-Mitarbeiter mit Personalnummer/)).toBeTruthy()
  })

  it("nennt die Ausschlussgründe der Mitarbeiter-Anlage vollständig", () => {
    render(<StepNotes steps={RUN_SCOPE_SPECS["dimacon-clockin"]!.steps} />)

    const note = screen.getByText(/nur Clockin-Mitarbeiter mit Personalnummer/).textContent ?? ""
    for (const rule of [
      "Personalnummer",
      "Namen",
      "Vertrag",
      "namensähnlicher",
      "doppelt",
      "OHNE Team",
      "Begründung",
    ]) {
      expect(note).toContain(rule)
    }
  })

  it("erklärt den Archiv-Horizont, der sonst nirgends sichtbar wäre", () => {
    render(<StepNotes steps={RUN_SCOPE_SPECS["dimacon-clockin"]!.steps} />)

    expect(screen.getByText(/Planungshorizont von ±14 Tagen/)).toBeTruthy()
  })

  it("rendert nichts, wenn kein Schritt eine Bedingung trägt", () => {
    const { container } = render(
      <StepNotes steps={[{ key: "a", label: "Ohne Regel", default: true }]} />,
    )

    expect(container.firstChild).toBeNull()
  })
})
