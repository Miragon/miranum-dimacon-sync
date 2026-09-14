// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionExpiredOverlay } from "./SessionExpiredOverlay"

afterEach(cleanup)

describe("SessionExpiredOverlay", () => {
  it("bietet einen Rückweg in der Seite an — ohne Re-Login", () => {
    render(<SessionExpiredOverlay reason="refresh-failed" onRetry={vi.fn()} onSignIn={vi.fn()} />)

    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Neu anmelden" })).toBeTruthy()
  })

  it("löst den stillen Refresh aus, statt sofort den PKCE-Redirect zu starten", async () => {
    const onRetry = vi.fn(async () => true)
    const onSignIn = vi.fn()

    render(<SessionExpiredOverlay reason="refresh-failed" onRetry={onRetry} onSignIn={onSignIn} />)
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1)
    })
    expect(onSignIn).not.toHaveBeenCalled()
  })

  it("zeigt nach einem gescheiterten Versuch den Hinweis auf die Neuanmeldung", async () => {
    render(
      <SessionExpiredOverlay
        reason="refresh-failed"
        onRetry={vi.fn(async () => false)}
        onSignIn={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(screen.getByText(/Erneuern fehlgeschlagen/)).toBeTruthy()
    })
    // Der Rückweg bleibt offen — ein zweiter Versuch ist möglich.
    expect(screen.getByRole("button", { name: "Erneut versuchen" }).hasAttribute("disabled")).toBe(
      false,
    )
  })

  /**
   * REGRESSION (live gemessen): Im 401-Dauerfall stand hinter dem Overlay eine
   * leere Seite — der TenantGate hängt dann in seinem Ladezustand. Der Text
   * sicherte trotzdem pauschal zu „Ihre Eingaben bleiben erhalten". Die Zusage
   * gehört an die AKTION, nicht an den Inhalt dahinter.
   */
  it("verspricht nur, was die Aktion halten kann", () => {
    const { container } = render(
      <SessionExpiredOverlay reason="refresh-failed" onRetry={vi.fn()} onSignIn={vi.fn()} />,
    )

    expect(container.textContent).not.toMatch(/Ihre Eingaben bleiben erhalten/)
    // Die Beruhigung bleibt — aber gebunden an „Erneut versuchen".
    expect(container.textContent).toMatch(
      /Erneut versuchen[^]*setzt genau hier fort und behält, was Sie gerade offen haben/,
    )
    expect(container.textContent).toMatch(/Neu anmelden[^]*lädt die Anwendung neu/)
  })

  it("meldet auch eine geworfene Rejection als gescheiterten Versuch", async () => {
    render(
      <SessionExpiredOverlay
        reason="refresh-failed"
        onRetry={vi.fn(() => Promise.reject(new Error("boom")))}
        onSignIn={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(screen.getByText(/Erneuern fehlgeschlagen/)).toBeTruthy()
    })
  })
})

/**
 * REGRESSION (live gemessen, Szenario B): Alle `/api/*` antworten 401, die
 * Sitzung ist intakt. `createApiFetch` fährt dann einen Force-Refresh, der
 * GELINGT (api.workos.com → 200), und erst der Retry bekommt 401. Ein Overlay,
 * das dort „Der Anmeldedienst konnte die Sitzung nicht erneuern" behauptet,
 * beschreibt das Gegenteil des Gemessenen und schickt den Betreiber zur
 * falschen Ursache.
 */
describe("SessionExpiredOverlay — Diagnose je Grund", () => {
  it("nennt bei einem abgelehnten Token den Server, nicht den Anmeldedienst", () => {
    const { container } = render(
      <SessionExpiredOverlay reason="server-rejected" onRetry={vi.fn()} onSignIn={vi.fn()} />,
    )

    expect(screen.getByText("Zugriff abgelehnt")).toBeTruthy()
    expect(container.textContent).toMatch(
      /Die Anmeldung wurde soeben erneuert, der Server weist sie trotzdem zurück/,
    )
    // Die falsche Diagnose darf hier nirgends mehr stehen …
    expect(container.textContent).not.toMatch(/konnte die Sitzung gerade nicht erneuern/)
    expect(screen.queryByText("Anmeldung nicht erneuert")).toBeNull()
    // … und der Nutzer erfährt, dass eine Neuanmeldung daran nichts ändert.
    expect(container.textContent).toMatch(/eine Neuanmeldung ändert daran in der Regel nichts/)
  })

  it("bleibt beim gescheiterten Refresh bei der Diagnose Anmeldedienst", () => {
    const { container } = render(
      <SessionExpiredOverlay reason="refresh-failed" onRetry={vi.fn()} onSignIn={vi.fn()} />,
    )

    expect(screen.getByText("Anmeldung nicht erneuert")).toBeTruthy()
    expect(container.textContent).toMatch(
      /Der Anmeldedienst konnte die Sitzung gerade nicht erneuern/,
    )
    expect(screen.queryByText("Zugriff abgelehnt")).toBeNull()
  })

  it("bietet in beiden Fällen denselben Rückweg an", () => {
    for (const reason of ["refresh-failed", "server-rejected"] as const) {
      const { unmount } = render(
        <SessionExpiredOverlay reason={reason} onRetry={vi.fn()} onSignIn={vi.fn()} />,
      )
      expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Neu anmelden" })).toBeTruthy()
      unmount()
    }
  })
})
