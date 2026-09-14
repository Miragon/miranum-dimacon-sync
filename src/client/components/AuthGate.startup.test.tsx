// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubEnv("VITE_WORKOS_CLIENT_ID", "client_test")

const stubs = vi.hoisted(() => ({
  user: { id: "user_1" } as { id: string } | null,
  isLoading: true,
  getAccessToken: vi.fn<(opts?: { forceRefresh?: boolean }) => Promise<string>>(),
  signIn: vi.fn<() => Promise<void>>(),
  signOut: vi.fn<() => void>(),
}))

/**
 * `AuthKitError` muss aus demselben Modul kommen wie in `api.ts` — nur davon
 * hängt `isSessionTerminal()` ab. `LoginRequiredError` ist in authkit-js eine
 * Ableitung davon und genau der Fehler, den der NOOP-Client des Providers
 * wirft, solange `createClient` noch läuft.
 */
const { AuthKitError, LoginRequiredError } = vi.hoisted(() => {
  class AuthKitError extends Error {}
  class LoginRequiredError extends AuthKitError {}
  return { AuthKitError, LoginRequiredError }
})

vi.mock("@workos-inc/authkit-react", () => ({
  AuthKitError,
  useAuth: () => ({
    user: stubs.user,
    organizationId: null,
    isLoading: stubs.isLoading,
    signIn: stubs.signIn,
    getAccessToken: stubs.getAccessToken,
    signOut: stubs.signOut,
  }),
  getClaims: () => ({}),
}))

// Der ECHTE TenantGate — er ist der erste Consumer von `apiFetch` und damit
// derjenige, der im Fenster unten den verhängnisvollen Request abgesetzt hat.
const { AUTH_INIT_TIMEOUT_MS, AuthGate } = await import("./AuthGate")

const ME = {
  userId: "user_1",
  organizationId: "org_1",
  tenant: { id: "t1", name: "Acme" },
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  stubs.user = { id: "user_1" }
  stubs.isLoading = true
  // Der NOOP-Client des Providers: lehnt SOFORT ab, ohne je ins Netz zu gehen.
  stubs.getAccessToken.mockRejectedValue(new LoginRequiredError("login required"))
  stubs.signIn.mockResolvedValue(undefined)
  fetchMock = vi.fn((input: string) =>
    Promise.resolve(
      new Response(JSON.stringify(input === "/api/tenants" ? [] : ME), { status: 200 }),
    ),
  )
  vi.stubGlobal("fetch", fetchMock)
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

/**
 * REGRESSION (aus einem HAR-Mitschnitt des allerersten Logins auf Stage
 * belegt): Sechs Requests, alle mit Status 200 — und trotzdem stand das
 * Overlay „Anmeldung nicht erneuert" über der fertig geladenen App.
 *
 * Ursache ist ein Render-Fenster im AuthKitProvider: `createClient()` ruft
 * während seiner Initialisierung schon `onRefresh`, das `user` setzt, während
 * `client` noch der `NOOP_CLIENT` ist (`getAccessToken` =
 * `Promise.reject(new LoginRequiredError())`). Der erste API-Call in diesem
 * Fenster scheitert, OHNE dass ein Request rausgeht — deshalb steht im HAR
 * nichts davon —, und `isSessionTerminal()` stuft ihn korrekt als endgültig
 * ein. `isLoading` markiert genau dieses Fenster.
 */
describe("AuthGate — Fenster zwischen Benutzer und einsatzbereitem Client", () => {
  it("setzt keine Requests ab und erklärt die Sitzung nicht für abgelaufen", async () => {
    render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )

    // Grosszügig Mikrotasks abarbeiten lassen: Ein Request und die ganze
    // Kette aus 401-Behandlung und Force-Refresh hätten hier längst laufen
    // können — das Fenster wird in echt schliesslich auch erst Millisekunden
    // später geschlossen.
    for (let i = 0; i < 10; i++) await act(async () => undefined)

    // Der Kern: In diesem Fenster darf gar nichts passieren.
    expect(screen.queryByText("Anmeldung nicht erneuert")).toBeNull()
    expect(screen.queryByText("Zugriff abgelehnt")).toBeNull()
    // Kein Token angefragt — der NOOP-Client hätte sofort und terminal
    // abgelehnt, ohne je ins Netz zu gehen.
    expect(stubs.getAccessToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    // Stattdessen eine Warteanzeige, die den Zustand richtig benennt: Es wird
    // gerade nirgendwohin weitergeleitet.
    expect(screen.getByText(/anmeldung wird vorbereitet/i)).toBeTruthy()
    // Und kein Redirect: die Anmeldung läuft ja gerade erfolgreich.
    expect(stubs.signIn).not.toHaveBeenCalled()
  })

  it("lädt normal, sobald der echte Client da ist", async () => {
    const { rerender } = render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )

    // Millisekunden später: `setClient(echterClient)` + `isLoading: false`.
    stubs.isLoading = false
    stubs.getAccessToken.mockResolvedValue("tok")
    rerender(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByText("app")).toBeTruthy()
    })
    expect(screen.queryByText("Anmeldung nicht erneuert")).toBeNull()
    expect(screen.queryByText("Zugriff abgelehnt")).toBeNull()
    expect(fetchMock).toHaveBeenCalled()
  })

  /**
   * Der Wachhund muss auch hier greifen: Schliesst sich das Fenster nie (weil
   * `createClient` ablehnt und `isLoading` für immer `true` bleibt — das
   * `.then(...)` hat kein `.catch()`), wäre die Seite ohne ihn dauerhaft in
   * der Warteanzeige gefangen, und zwar jetzt AUCH mit gesetztem Benutzer.
   */
  it("bietet einen Rückweg an, wenn sich das Fenster nie schliesst", () => {
    vi.useFakeTimers()
    try {
      render(
        <AuthGate>
          <p>app</p>
        </AuthGate>,
      )
      act(() => {
        vi.advanceTimersByTime(AUTH_INIT_TIMEOUT_MS)
      })

      expect(screen.getByText("Anmeldung hängt")).toBeTruthy()
      expect(screen.getByRole("button", { name: "Neu starten" })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
