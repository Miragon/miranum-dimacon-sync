// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { notifySessionExpired } from "#/lib/session-expiry"

const stubs = vi.hoisted(() => ({
  getAccessToken: vi.fn<(opts?: { forceRefresh?: boolean }) => Promise<string>>(),
  signIn: vi.fn<() => Promise<void>>(),
}))

// api.ts importiert `AuthKitError` aus demselben Modul — der Mock muss es mitliefern.
vi.mock("@workos-inc/authkit-react", () => ({
  AuthKitError: class AuthKitError extends Error {},
  useAuth: () => ({
    user: { id: "user_1" },
    isLoading: false,
    signIn: stubs.signIn,
    getAccessToken: stubs.getAccessToken,
    signOut: vi.fn(),
  }),
}))

// Der TenantGate lädt /api/me — für dieses Gate irrelevant.
vi.mock("#/components/TenantGate", () => ({
  TenantGate: ({ children }: { children: React.ReactNode }) => children,
}))

const { AuthGate } = await import("./AuthGate")

/** Ein Formular mit Eingaben, die der Abgelaufen-Zustand NICHT verwerfen darf. */
function AppWithForm() {
  return <input aria-label="cron" defaultValue="" />
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  stubs.getAccessToken.mockResolvedValue("tok")
  stubs.signIn.mockResolvedValue(undefined)
})

describe("AuthGate — Abgelaufen-Overlay", () => {
  it("legt sich über die App, ohne Eingaben zu verwerfen, und lässt sich still heilen", async () => {
    render(
      <AuthGate>
        <AppWithForm />
      </AuthGate>,
    )

    const input = screen.getByLabelText<HTMLInputElement>("cron")
    fireEvent.change(input, { target: { value: "0 6 * * *" } })

    // Das ist der Pfad von `onRefreshFailure` am AuthKitProvider.
    act(() => {
      notifySessionExpired()
    })
    expect(screen.getByText("Sitzung abgelaufen")).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>("cron").value).toBe("0 6 * * *")

    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(screen.queryByText("Sitzung abgelaufen")).toBeNull()
    })
    // Erzwungener Refresh — authkit steht nach dem Fehlschlag im ERROR-State
    // und refresht von sich aus nicht mehr.
    expect(stubs.getAccessToken).toHaveBeenCalledWith({ forceRefresh: true })
    // Kein PKCE-Redirect: die Eingabe lebt weiter.
    expect(stubs.signIn).not.toHaveBeenCalled()
    expect(screen.getByLabelText<HTMLInputElement>("cron").value).toBe("0 6 * * *")
  })

  it("bleibt stehen, wenn die Session wirklich weg ist", async () => {
    render(
      <AuthGate>
        <AppWithForm />
      </AuthGate>,
    )

    act(() => {
      notifySessionExpired()
    })
    stubs.getAccessToken.mockRejectedValue(new Error("login required"))
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(screen.getByText(/Erneuern fehlgeschlagen/)).toBeTruthy()
    })
    expect(screen.getByText("Sitzung abgelaufen")).toBeTruthy()
  })
})
