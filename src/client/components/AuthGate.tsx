import { useAuth } from "@workos-inc/authkit-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { SessionExpiredOverlay } from "#/components/SessionExpiredOverlay"
import { TenantGate } from "#/components/TenantGate"
import { Button } from "#/components/ui/button"
import { ApiFetchContext, createApiFetch, isSameOrganization } from "#/lib/api"
import { currentReturnTo } from "#/lib/return-to"
import { subscribeSessionExpired } from "#/lib/session-expiry"
import { pinOrganization } from "#/lib/workos-org-pin"

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading, signIn, getAccessToken, organizationId } = useAuth()
  const [signInError, setSignInError] = useState<string | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)

  /**
   * Organisation, in der diese Sitzung begonnen hat — EINMAL gemerkt.
   *
   * LOAD-BEARING, dass das ein Ref und kein State ist: Liefert ein Refresh ein
   * Token der falschen Organisation, ruft authkit noch im Erfolgspfad seinen
   * `onRefresh`-Callback und der Provider schreibt `organizationId` sofort auf
   * den falschen Wert um. Ein Vergleich gegen `useAuth().organizationId` wäre
   * damit nur EINEN Zyklus lang fail-closed und danach fail-open — der zweite
   * Klick auf „Erneut versuchen" bestätigte den Mandantenwechsel.
   *
   * Nebeneffekt (gewollt): der Wert steht NICHT in den useMemo-Deps unten, die
   * apiFetch-Identität bleibt damit bitgenau so stabil wie bisher. Zurückgesetzt
   * wird der Latch durch den Hard-Reload des Mandanten-Switchers.
   */
  const expectedOrg = useRef<string | null>(null)
  if (organizationId && expectedOrg.current === null) expectedOrg.current = organizationId
  const getExpectedOrganizationId = useCallback(() => expectedOrg.current, [])

  const startSignIn = useCallback(() => {
    setSignInError(null)
    // Rücksprungziel mitgeben — sonst landet auch der stille Roundtrip auf `/`.
    signIn({ state: { returnTo: currentReturnTo(window.location) } }).catch((err: unknown) => {
      setSignInError(err instanceof Error ? err.message : String(err))
    })
  }, [signIn])

  useEffect(() => {
    if (!isLoading && !user && !signInError && !sessionExpired) {
      startSignIn()
    }
  }, [isLoading, user, signInError, sessionExpired, startSignIn])

  // Bridge für `onRefreshFailure` am AuthKitProvider (hängt außerhalb des Routers).
  useEffect(() => subscribeSessionExpired(() => setSessionExpired(true)), [])

  /**
   * Rückweg IN der Seite. `onRefreshFailure` feuert in authkit-js bei JEDER
   * fehlerhaften Antwort des Refresh-Endpunkts — ein transienter 429/5xx von
   * WorkOS ist dort nicht von einer widerrufenen Session zu unterscheiden.
   * In Produktion läuft der Refresh gegen das WorkOS-Session-Cookie, das
   * dabei unangetastet bleibt; ein erzwungener Refresh gelingt nach dem
   * Aussetzer also wieder. `forceRefresh` ist nötig, weil authkit nach dem
   * Fehlschlag im ERROR-State steht und von sich aus nicht mehr refresht.
   */
  const retrySession = useCallback(async () => {
    try {
      // Organisation zurückschreiben, BEVOR der Refresh rausgeht: authkit hat
      // sie beim Fehlschlag zusammen mit dem Memory-Token gelöscht und
      // schickte sonst kein `organization_id` mit.
      pinOrganization(expectedOrg.current)
      const token = await getAccessToken({ forceRefresh: true })
      // Fail-closed, falls der Pin ins Leere lief: ein Token einer anderen
      // Organisation heilt die Sitzung NICHT — es schöbe die UI still in einen
      // fremden Mandanten. Overlay bleibt stehen, „Neu anmelden" hilft.
      if (!isSameOrganization(token, expectedOrg.current)) return false
      setSessionExpired(false)
      return true
    } catch {
      return false
    }
  }, [getAccessToken])

  useEffect(() => {
    // Ersatz für `onBeforeAutoRefresh`: authkit-react 0.16.1 reicht die Option
    // NICHT an createClient weiter, deshalb refreshen wir selbst, sobald der
    // Tab wieder sichtbar wird — bevor die ersten Requests rausgehen.
    const onVisible = () => {
      if (!document.hidden) {
        // Fehler hier bleiben still — der nächste API-Call eskaliert sauber.
        void getAccessToken().catch(() => null)
      }
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [getAccessToken])

  // LOAD-BEARING: `sessionExpired` darf NICHT in den Deps stehen. Sonst
  // wechselt die apiFetch-Identität und alle Consumer (useEffect-Deps)
  // laufen in eine Refetch-Schleife.
  const auth = useMemo(
    () =>
      user
        ? {
            getToken: getAccessToken,
            getExpectedOrganizationId,
            onSessionExpired: () => setSessionExpired(true),
          }
        : null,
    [user, getAccessToken, getExpectedOrganizationId],
  )
  const apiFetch = useMemo(() => createApiFetch(auth), [auth])

  if (!user) {
    // Ohne User gibt es keinen State mehr zu schützen — statt des Overlays
    // hier der Vollbild-Hinweis, damit „abgelaufen" nie in einer
    // handlungslosen „weiterleiten …"-Anzeige endet (Auto-signIn ist in
    // diesem Zustand bewusst aus).
    return (
      <div className="flex min-h-screen items-center justify-center">
        {signInError || sessionExpired ? (
          <div className="w-full max-w-md space-y-4 px-6">
            <MnAlert label={signInError ? "Anmeldung fehlgeschlagen" : "Sitzung abgelaufen"}>
              {signInError ?? "Ihre Anmeldung ist abgelaufen. Bitte melden Sie sich neu an."}
            </MnAlert>
            <Button onClick={startSignIn}>
              {signInError ? "erneut versuchen" : "Neu anmelden"}
            </Button>
          </div>
        ) : (
          <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">
            weiterleiten zu workos …
          </p>
        )}
      </div>
    )
  }

  return (
    <ApiFetchContext.Provider value={apiFetch}>
      <TenantGate>{children}</TenantGate>
      {/* Über dem TenantGate — greift auch, wenn der gerade seinen Fehlerzustand zeigt. */}
      {sessionExpired ? (
        <SessionExpiredOverlay onRetry={retrySession} onSignIn={startSignIn} error={signInError} />
      ) : null}
    </ApiFetchContext.Provider>
  )
}
