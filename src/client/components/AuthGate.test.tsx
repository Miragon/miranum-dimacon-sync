// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useContext } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiFetch } from "#/lib/api"
import { notifySessionExpired } from "#/lib/session-expiry"

// Der Org-Pin hängt an VITE_WORKOS_CLIENT_ID (Modul-Konstante in auth-flag.ts),
// die beim Import gelesen wird — deshalb VOR dem dynamischen Import unten.
vi.stubEnv("VITE_WORKOS_CLIENT_ID", "client_test")

const stubs = vi.hoisted(() => ({
  /**
   * STABILE Referenz — genau wie in echt: authkit-react hält `user` im
   * Provider-State und gibt bei unveränderter Session bewusst das ALTE Objekt
   * zurück (`isEquivalentWorkOSSession(prev, next) ? prev : next`). Ein
   * frisches Literal je `useAuth()`-Aufruf invalidierte die useMemo-Deps in
   * AuthGate bei JEDEM Render — der Identitäts-Test unten wäre dann wertlos.
   */
  user: { id: "user_1" },
  organizationId: null as string | null,
  getAccessToken: vi.fn<(opts?: { forceRefresh?: boolean }) => Promise<string>>(),
  signIn: vi.fn<() => Promise<void>>(),
}))

// api.ts importiert `AuthKitError` aus demselben Modul — der Mock muss es mitliefern.
vi.mock("@workos-inc/authkit-react", () => ({
  AuthKitError: class AuthKitError extends Error {},
  useAuth: () => ({
    user: stubs.user,
    organizationId: stubs.organizationId,
    isLoading: false,
    signIn: stubs.signIn,
    getAccessToken: stubs.getAccessToken,
    signOut: vi.fn(),
  }),
  getClaims: (token: string) => JSON.parse(atob(token.split(".")[1])) as { org_id?: string },
}))

// Der TenantGate lädt /api/me — für dieses Gate irrelevant.
vi.mock("#/components/TenantGate", () => ({
  TenantGate: ({ children }: { children: React.ReactNode }) => children,
}))

const { AuthGate } = await import("./AuthGate")
// Muss dieselbe Modul-Instanz sein wie die, die AuthGate benutzt — sonst
// vergliche die Probe einen fremden Context.
const { ApiFetchContext, useApiFetch } = await import("#/lib/api")

/** Ein Formular mit Eingaben, die der Abgelaufen-Zustand NICHT verwerfen darf. */
function AppWithForm() {
  return <input aria-label="cron" defaultValue="" />
}

/** Signaturloses JWT — der `getClaims`-Mock oben dekodiert nur den Payload. */
function jwtFor(orgId: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${seg({ alg: "none" })}.${seg({ org_id: orgId })}.sig`
}

/** Jede apiFetch-Identität, die die Kinder über den Context zu sehen bekommen. */
const seenApiFetch: ApiFetch[] = []
const seenContext: (ApiFetch | null)[] = []

function ApiFetchProbe() {
  seenContext.push(useContext(ApiFetchContext))
  seenApiFetch.push(useApiFetch())
  return null
}

/** Letzter aufgezeichneter Wert — der Consumer rendert nur bei Context-Wechsel neu. */
const latestApiFetch = () => seenApiFetch[seenApiFetch.length - 1]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  stubs.getAccessToken.mockResolvedValue("tok")
  stubs.signIn.mockResolvedValue(undefined)
  stubs.organizationId = null
  stubs.user = { id: "user_1" }
  seenApiFetch.length = 0
  seenContext.length = 0
  sessionStorage.clear()
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

describe("AuthGate — Organisation beim Retry (#5)", () => {
  it("heilt die Sitzung nicht mit einem Token einer anderen Organisation", async () => {
    stubs.organizationId = "org_original"
    render(
      <AuthGate>
        <AppWithForm />
      </AuthGate>,
    )

    act(() => {
      notifySessionExpired()
    })
    // authkit hat beim Fehlschlag die gemerkte Organisation gelöscht; der
    // erzwungene Refresh liefert deshalb ein Token der Default-Organisation.
    stubs.getAccessToken.mockResolvedValue(jwtFor("org_fremd"))
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(screen.getByText(/Erneuern fehlgeschlagen/)).toBeTruthy()
    })
    // Overlay bleibt — sonst arbeitete die UI still im falschen Mandanten.
    expect(screen.getByText("Sitzung abgelaufen")).toBeTruthy()
    // Vor dem Refresh wird die erwartete Organisation zurückgeschrieben, damit
    // der POST überhaupt wieder ein `organization_id` trägt.
    expect(sessionStorage.getItem("workos-org-id:client_test")).toBe("org_original")
  })

  it("bleibt auch beim zweiten Versuch fail-closed, wenn authkit die Org umschreibt", async () => {
    stubs.organizationId = "org_original"
    const { rerender } = render(
      <AuthGate>
        <AppWithForm />
      </AuthGate>,
    )

    act(() => {
      notifySessionExpired()
    })
    stubs.getAccessToken.mockResolvedValue(jwtFor("org_fremd"))
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))
    await waitFor(() => {
      expect(screen.getByText(/Erneuern fehlgeschlagen/)).toBeTruthy()
    })

    // Das ist der Kern: der Falsch-Org-Refresh war auf authkit-Ebene
    // ERFOLGREICH und schreibt den Provider-State über seinen eigenen
    // `onRefresh`-Callback um — inklusive eines frischen `user`-Objekts.
    // Genau das wird hier nachgestellt.
    stubs.organizationId = "org_fremd"
    stubs.user = { id: "user_1" }
    act(() => {
      rerender(
        <AuthGate>
          <AppWithForm />
        </AuthGate>,
      )
    })

    // Würde der Guard gegen `useAuth().organizationId` prüfen statt gegen den
    // Latch, wäre die FALSCHE Organisation ab jetzt die „Erwartung" und dieser
    // zweite Klick vollzöge den Mandantenwechsel still.
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(stubs.getAccessToken).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByText("Sitzung abgelaufen")).toBeTruthy()
  })

  it("heilt normal, wenn der Refresh dieselbe Organisation liefert", async () => {
    stubs.organizationId = "org_original"
    render(
      <AuthGate>
        <AppWithForm />
      </AuthGate>,
    )

    act(() => {
      notifySessionExpired()
    })
    stubs.getAccessToken.mockResolvedValue(jwtFor("org_original"))
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))

    await waitFor(() => {
      expect(screen.queryByText("Sitzung abgelaufen")).toBeNull()
    })
  })
})

describe("AuthGate — apiFetch-Identität (#17)", () => {
  it("wechselt nicht, wenn nur sessionExpired kippt", async () => {
    render(
      <AuthGate>
        <ApiFetchProbe />
      </AuthGate>,
    )

    // Beweist in einem Zug, dass die Probe gerendert hat UND dass hier der
    // Provider gemessen wird, nicht das Modul-Singleton aus api.ts.
    expect(seenContext[0]).toBeTypeOf("function")
    expect(seenApiFetch[0]).toBe(seenContext[0])
    const initial = seenApiFetch[0]

    // Pfad von `onRefreshFailure` am AuthKitProvider: sessionExpired false → true.
    act(() => {
      notifySessionExpired()
    })
    expect(screen.getByText("Sitzung abgelaufen")).toBeTruthy()
    expect(latestApiFetch()).toBe(initial)

    // …und zurück auf false: auch das Heilen erzeugt keine neue Identität.
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }))
    await waitFor(() => {
      expect(screen.queryByText("Sitzung abgelaufen")).toBeNull()
    })
    expect(latestApiFetch()).toBe(initial)

    // LOAD-BEARING (AuthGate.tsx): `sessionExpired` darf NICHT in den
    // useMemo-Deps von `auth` stehen — weder direkt noch dadurch, dass der
    // Callback es liest. Sonst bekommt der Context bei jedem Ablauf/Heilen eine
    // neue Funktion und alle Consumer, die `apiFetch` in Hook-Deps haben
    // (TenantGate, MappingPanel, RunHistory, routes/settings, routes/sync.index,
    // routes/sync.$integrationId, routes/modules, routes/sync_…settings), laden neu.
    //
    // Ein echter Wechsel von `user` (Org-Switch) DARF dagegen eine neue
    // Identität erzeugen — `stubs.user` ist hier bewusst eingefroren, um
    // allein `sessionExpired` zu isolieren.
    expect(new Set(seenApiFetch).size).toBe(1)
  })
})
