// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { DimaconLexofficeResult } from "./DimaconLexofficeResult"
import type { CustomerSyncResult } from "./DimaconLexofficeResult"

afterEach(cleanup)

function result(overrides: Partial<CustomerSyncResult> = {}): CustomerSyncResult {
  return {
    dryRun: true,
    durationMs: 1200,
    steps: { createContacts: true, alignNumbers: true, importFromLexware: false },
    customers: [],
    imports: [],
    errors: [],
    ...overrides,
  }
}

const IMPORT_ON = { createContacts: true, alignNumbers: true, importFromLexware: true }

describe("DimaconLexofficeResult — Übernahme aus Lexware", () => {
  it("meldet den abgeschalteten Opt-in NICHT als abgeschalteten Schritt", () => {
    // „aus" ist der Normalfall — eine Warn-Badge wäre bei jedem Lauf ein Fehlalarm
    render(<DimaconLexofficeResult result={result()} />)

    expect(screen.queryByText(/übernahme/i)).toBeNull()
    expect(screen.queryByText("Aus Lexware übernommen")).toBeNull()
  })

  it("zeigt übernommene und übersprungene Kontakte mit Belegen und Begründung", () => {
    render(
      <DimaconLexofficeResult
        result={result({
          steps: IMPORT_ON,
          imports: [
            {
              lexwareContactId: "lex-neu",
              lexwareNumber: "10010",
              name: "Neu GmbH",
              vouchers: ["AG0004", "AB0002"],
              status: "created",
              reason: "[dryRun] Dimacon-Kunde würde angelegt",
            },
            {
              lexwareContactId: "lex-alt",
              lexwareNumber: "10011",
              name: "Alt GmbH",
              vouchers: ["AG0005"],
              status: "skipped",
              reason: "In Dimacon gibt es schon „Alt GmbH & Co. KG“",
            },
          ],
        })}
      />,
    )

    expect(screen.getByText("übernahme aus lexware an")).toBeTruthy()
    expect(screen.getByText("Aus Lexware übernommen")).toBeTruthy()
    expect(screen.getByText("AG0004, AB0002")).toBeTruthy()
    expect(screen.getByText(/In Dimacon gibt es schon/)).toBeTruthy()
    expect(screen.getByText("übernahme created · 1")).toBeTruthy()
    expect(screen.getByText("übernahme skipped · 1")).toBeTruthy()
  })

  it("sagt ausdrücklich, wenn nichts zu übernehmen war", () => {
    render(<DimaconLexofficeResult result={result({ steps: IMPORT_ON })} />)
    expect(screen.getByText(/Nichts zu übernehmen/)).toBeTruthy()
  })

  it("gibt keine Entwarnung, wenn die Übernahme gar nicht laufen konnte", () => {
    render(
      <DimaconLexofficeResult
        result={result({
          steps: IMPORT_ON,
          errors: [{ scope: "import", message: "Lexware-Belege nicht vollständig geladen" }],
        })}
      />,
    )

    expect(screen.queryByText(/Nichts zu übernehmen/)).toBeNull()
    expect(screen.getByText("Lexware-Belege nicht vollständig geladen")).toBeTruthy()
  })

  it("rendert Läufe aus der Zeit vor der Übernahme (ohne imports-Feld)", () => {
    const old = result({ steps: { createContacts: true, alignNumbers: true } })
    delete old.imports
    render(<DimaconLexofficeResult result={old} />)
    expect(screen.queryByText("Aus Lexware übernommen")).toBeNull()
  })
})
