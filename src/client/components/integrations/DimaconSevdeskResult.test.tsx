// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { DimaconSevdeskResult } from "./DimaconSevdeskResult"
import type { SevdeskSyncResult } from "./DimaconSevdeskResult"

afterEach(cleanup)

function result(overrides: Partial<SevdeskSyncResult> = {}): SevdeskSyncResult {
  return {
    dryRun: true,
    durationMs: 1200,
    steps: { createContacts: true, alignNumbers: true },
    customers: [],
    errors: [],
    ...overrides,
  }
}

describe("DimaconSevdeskResult", () => {
  it("zeigt Zeilen mit sevDesk-Nummer, Kontakt-ID und Begründung", () => {
    render(
      <DimaconSevdeskResult
        result={result({
          customers: [
            {
              dimaconCustomerId: "cust-1",
              name: "Muster GmbH",
              sevdeskContactId: "sev-1",
              sevdeskNumber: "S-200",
              status: "aligned",
              reason: "D-100 → S-200",
            },
            {
              dimaconCustomerId: "cust-2",
              name: "Zwei GmbH",
              status: "ambiguous",
              reason: "2 sevDesk-Kontakte mit gleichem Namen",
            },
          ],
        })}
      />,
    )

    expect(screen.getByText("S-200")).toBeTruthy()
    expect(screen.getByText("sev-1")).toBeTruthy()
    expect(screen.getByText("D-100 → S-200")).toBeTruthy()
    expect(screen.getByText("aligned · 1")).toBeTruthy()
    expect(screen.getByText("ambiguous · 1")).toBeTruthy()
  })

  it("meldet abgeschaltete Schritte als Warn-Badge", () => {
    render(
      <DimaconSevdeskResult
        result={result({ steps: { createContacts: false, alignNumbers: true } })}
      />,
    )
    expect(screen.getByText("kontakte anlegen aus")).toBeTruthy()
  })

  it("listet Fehler mit Scope und Referenz", () => {
    render(
      <DimaconSevdeskResult
        result={result({
          errors: [
            { scope: "customer", refId: "cust-1", message: "Adresse konnte nicht angelegt werden" },
          ],
        })}
      />,
    )
    expect(screen.getByText("customer · cust-1")).toBeTruthy()
    expect(screen.getByText(/Adresse konnte nicht angelegt werden/)).toBeTruthy()
  })

  it("rendert Ergebnisse ohne steps/metrics (ältere Server)", () => {
    const old = result()
    delete old.steps
    render(<DimaconSevdeskResult result={old} />)
    expect(screen.getByText("Zusammenfassung")).toBeTruthy()
  })
})
