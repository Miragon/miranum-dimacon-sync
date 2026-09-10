// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionExpiredOverlay } from "./SessionExpiredOverlay"

afterEach(cleanup)

describe("SessionExpiredOverlay", () => {
  it("bietet einen Rückweg in der Seite an — ohne Re-Login", () => {
    render(<SessionExpiredOverlay onRetry={vi.fn()} onSignIn={vi.fn()} />)

    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Neu anmelden" })).toBeTruthy()
  })

  it("löst den stillen Refresh aus, statt sofort den PKCE-Redirect zu starten", async () => {
    const onRetry = vi.fn(async () => true)
    const onSignIn = vi.fn()

    render(<SessionExpiredOverlay onRetry={onRetry} onSignIn={onSignIn} />)
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1)
    })
    expect(onSignIn).not.toHaveBeenCalled()
  })

  it("zeigt nach einem gescheiterten Versuch den Hinweis auf die Neuanmeldung", async () => {
    render(<SessionExpiredOverlay onRetry={vi.fn(async () => false)} onSignIn={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(screen.getByText(/Erneuern fehlgeschlagen/)).toBeTruthy()
    })
    // Der Rückweg bleibt offen — ein zweiter Versuch ist möglich.
    expect(screen.getByRole("button", { name: "Erneut versuchen" }).hasAttribute("disabled")).toBe(
      false,
    )
  })

  it("meldet auch eine geworfene Rejection als gescheiterten Versuch", async () => {
    render(
      <SessionExpiredOverlay
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
