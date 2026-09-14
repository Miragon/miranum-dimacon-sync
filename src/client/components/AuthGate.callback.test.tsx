// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
// Nur als Typ — wird geloescht und stoert die Reihenfolge unten deshalb nicht.
import type * as AuthCallbackModule from "#/lib/auth-callback"

vi.stubEnv("VITE_WORKOS_CLIENT_ID", "client_test")

const stubs = vi.hoisted(() => ({
  user: { id: "user_1" } as { id: string } | null,
  isLoading: false,
  getAccessToken: vi.fn<(opts?: { forceRefresh?: boolean }) => Promise<string>>(),
  signIn: vi.fn<() => Promise<void>>(),
}))

vi.mock("@workos-inc/authkit-react", () => ({
  AuthKitError: class AuthKitError extends Error {},
  useAuth: () => ({
    user: stubs.user,
    organizationId: null,
    isLoading: stubs.isLoading,
    signIn: stubs.signIn,
    getAccessToken: stubs.getAccessToken,
    signOut: vi.fn(),
  }),
  getClaims: () => ({}),
}))

vi.mock("#/components/TenantGate", () => ({
  TenantGate: ({ children }: { children: React.ReactNode }) => children,
}))

/**
 * Nur der Notausgang wird ersetzt — Marker und Schleifenzähler bleiben echt,
 * genau die sind hier ja der Prüfgegenstand. `location.replace` liesse sich in
 * jsdom sonst nicht beobachten.
 */
vi.mock("#/lib/auth-callback", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthCallbackModule>()),
  reloadWithoutAuthParams: vi.fn(),
}))

/**
 * LOAD-BEARING für diese Datei: Die Adresse muss stehen, BEVOR der AuthGate
 * (und mit ihm `lib/auth-callback`) geladen wird — der Marker wird beim
 * Modul-Load gelesen. Genau so läuft es in echt: `main.tsx` importiert das
 * Modul, lange bevor der AuthKitProvider seinen Effekt fährt und authkit-js
 * die URL per `history.replaceState` bereinigt.
 */
window.history.replaceState({}, "", "/sync/dimacon-clockin?code=abc123&state=%7B%7D")
const { AUTH_INIT_TIMEOUT_MS, AuthGate } = await import("./AuthGate")
// LOAD-BEARING, dass auch DAS ein dynamischer Import ist: ein statischer würde
// hochgezogen und läse den Marker, bevor die Adresse oben gesetzt ist.
const { reloadWithoutAuthParams } = await import("#/lib/auth-callback")

// …und ab hier ist die URL sauber, exakt wie nach `#handleCallback`.
window.history.replaceState({}, "", "/sync/dimacon-clockin")

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  stubs.getAccessToken.mockResolvedValue("tok")
  stubs.signIn.mockResolvedValue(undefined)
  stubs.user = { id: "user_1" }
  stubs.isLoading = false
  sessionStorage.clear()
})

describe("AuthGate — gescheiterter Code-Tausch", () => {
  /**
   * REGRESSION (live gemessen): Der Code-Tausch antwortet mit 500, authkit-js
   * fängt den `CodeExchangeError` in `#handleCallback` ab, schreibt ihn NUR
   * per `console.error` und lässt `user` auf `null`. Der AuthGate sah darin
   * einen ganz normalen „nicht angemeldet"-Zustand und leitete sofort wieder
   * um — Redirect, Fehler, Redirect, bei leerer Seite und ohne jede Meldung.
   */
  it("zeigt einen Fehlerzustand, statt sofort erneut umzuleiten", async () => {
    stubs.user = null

    render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByText("Anmeldung nicht abgeschlossen")).toBeTruthy()
    })
    // Das ist der Kern: KEIN automatischer Redirect.
    expect(stubs.signIn).not.toHaveBeenCalled()
    expect(screen.queryByText(/weiterleiten zu workos/i)).toBeNull()
  })

  it("bietet den Weg zurück in die Anmeldung an — aber erst auf Klick", async () => {
    stubs.user = null

    render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )
    await waitFor(() => {
      expect(screen.getByText("Anmeldung nicht abgeschlossen")).toBeTruthy()
    })

    fireEvent.click(screen.getByRole("button", { name: "Erneut anmelden" }))
    expect(stubs.signIn).toHaveBeenCalledTimes(1)
  })

  it("hält während des laufenden Code-Tauschs still", () => {
    stubs.user = null
    stubs.isLoading = true

    render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )

    expect(screen.queryByText("Anmeldung nicht abgeschlossen")).toBeNull()
    expect(stubs.signIn).not.toHaveBeenCalled()
  })

  /** Der Normalfall darf davon NICHTS merken: Exchange 200 → Benutzer da. */
  it("lässt den erfolgreichen Rücksprung unangetastet durch", () => {
    render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )

    expect(screen.getByText("app")).toBeTruthy()
    expect(screen.queryByText("Anmeldung nicht abgeschlossen")).toBeNull()
    expect(stubs.signIn).not.toHaveBeenCalled()
  })
})

/**
 * REGRESSION: `codeExchangeFailed` hängt an `!isLoading` — und `isLoading` kann
 * für immer `true` bleiben. authkit-react 0.16.1 ruft `createClient(...).then(...)`
 * OHNE `.catch()`; lehnt `createClient` ab (abgeschnittener `state`-Parameter,
 * gesperrter Site-Storage), bleibt der Provider auf `initialState` stehen. Ohne
 * Wachhund steht die Seite dann dauerhaft in der handlungslosen
 * „anmeldung wird vorbereitet …"-Anzeige, und ein Reload reproduziert denselben Zustand,
 * weil authkit die URL nicht mehr bereinigt hat.
 */
describe("AuthGate — authkit wird gar nicht erst fertig", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("bietet nach einer Wartezeit einen Rückweg an, statt hängen zu bleiben", () => {
    stubs.user = null
    stubs.isLoading = true

    render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )
    // Vorher ist die Warteanzeige richtig — der Start darf dauern. Sie spricht
    // vom Start, nicht von einer Weiterleitung: umgeleitet wird hier nichts.
    expect(screen.getByText(/anmeldung wird vorbereitet/i)).toBeTruthy()
    expect(screen.queryByText("Anmeldung hängt")).toBeNull()

    act(() => {
      vi.advanceTimersByTime(AUTH_INIT_TIMEOUT_MS)
    })

    expect(screen.getByText("Anmeldung hängt")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Neu starten" })).toBeTruthy()
    expect(screen.queryByText(/anmeldung wird vorbereitet/i)).toBeNull()
    // Ein Redirect ist von hier aus ohnehin nicht möglich: der Provider
    // liefert im hängenden Zustand noch seinen NOOP-Client.
    expect(stubs.signIn).not.toHaveBeenCalled()
  })

  it("startet auf Klick ohne die Rücksprung-Daten neu, statt signIn zu rufen", () => {
    stubs.user = null
    stubs.isLoading = true

    render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )
    act(() => {
      vi.advanceTimersByTime(AUTH_INIT_TIMEOUT_MS)
    })
    fireEvent.click(screen.getByRole("button", { name: "Neu starten" }))

    expect(vi.mocked(reloadWithoutAuthParams)).toHaveBeenCalledTimes(1)
    expect(stubs.signIn).not.toHaveBeenCalled()
  })

  it("lässt einen langsamen, aber erfolgreichen Start in Ruhe", () => {
    stubs.user = null
    stubs.isLoading = true

    const { rerender } = render(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )
    act(() => {
      vi.advanceTimersByTime(AUTH_INIT_TIMEOUT_MS - 1)
    })

    stubs.isLoading = false
    stubs.user = { id: "user_1" }
    rerender(
      <AuthGate>
        <p>app</p>
      </AuthGate>,
    )
    act(() => {
      vi.advanceTimersByTime(AUTH_INIT_TIMEOUT_MS)
    })

    expect(screen.getByText("app")).toBeTruthy()
    expect(screen.queryByText("Anmeldung hängt")).toBeNull()
  })
})
