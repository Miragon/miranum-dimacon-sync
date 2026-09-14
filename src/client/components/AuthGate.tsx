import { useAuth } from "@workos-inc/authkit-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { SessionExpiredOverlay } from "#/components/SessionExpiredOverlay"
import { TenantGate } from "#/components/TenantGate"
import { Button } from "#/components/ui/button"
import {
  ApiFetchContext,
  createApiFetch,
  warnOnOrganizationDrift,
  type SessionExpiredReason,
} from "#/lib/api"
import {
  registerSignInAttempt,
  reloadWithoutAuthParams,
  resetSignInAttempts,
  wasAuthCallbackOnLoad,
} from "#/lib/auth-callback"
import { currentReturnTo } from "#/lib/return-to"
import { subscribeSessionExpired } from "#/lib/session-expiry"
import { pinOrganization } from "#/lib/workos-org-pin"

interface SignInNotice {
  label: string
  text: string
  action: string
  /**
   * `true` = die Schaltfläche startet die Seite ohne Query-String neu, statt
   * `signIn()` zu rufen. Nötig, wenn authkit gar nicht erst fertig geworden
   * ist: der Provider liefert dann noch seinen NOOP-Client, dessen `signIn`
   * ein leeres `async () => {}` ist — der Button täte sonst nichts.
   */
  restart?: boolean
}

/**
 * Vollbild-Hinweis für den abgemeldeten Zustand. Reihenfolge = Aussagekraft:
 * ein konkret geworfener Fehler schlägt den abgeleiteten Callback-Befund,
 * dieser den bloßen Schleifenverdacht.
 */
function signInNotice(state: {
  signInError: string | null
  authInitStalled: boolean
  codeExchangeFailed: boolean
  signInBlocked: boolean
  sessionExpired: boolean
}): SignInNotice | null {
  if (state.signInError) {
    return {
      label: "Anmeldung fehlgeschlagen",
      text: state.signInError,
      action: "erneut versuchen",
    }
  }
  if (state.authInitStalled) {
    return {
      label: "Anmeldung hängt",
      text:
        "Der Anmeldedienst ist nicht fertig geworden — die Seite wartet seit mehreren Sekunden " +
        "auf ihn. Das passiert, wenn der Rücksprung von WorkOS beschädigt ankommt oder der " +
        "Browser den Speicher dieser Seite sperrt. Ein Neustart ohne die Rücksprung-Daten " +
        "beginnt die Anmeldung von vorn.",
      action: "Neu starten",
      restart: true,
    }
  }
  if (state.codeExchangeFailed) {
    return {
      label: "Anmeldung nicht abgeschlossen",
      text:
        "Der Anmeldedienst hat die Anmeldung nicht bestätigt — sie wurde begonnen, aber nicht " +
        "zu Ende geführt. Häufigste Ursachen: eine zu lange offene Anmeldeseite oder eine " +
        "Störung bei WorkOS. Bitte starten Sie die Anmeldung erneut.",
      action: "Erneut anmelden",
    }
  }
  if (state.signInBlocked) {
    return {
      label: "Anmeldung bricht wiederholt ab",
      text:
        "Die Anmeldung wurde mehrfach hintereinander begonnen, ohne zustande zu kommen. " +
        "Weitere automatische Versuche sind gestoppt, damit die Seite nicht endlos umleitet. " +
        "Bitte starten Sie die Anmeldung erneut oder versuchen Sie es später noch einmal.",
      action: "Erneut anmelden",
    }
  }
  if (state.sessionExpired) {
    return {
      label: "Sitzung abgelaufen",
      text: "Ihre Anmeldung ist abgelaufen. Bitte melden Sie sich neu an.",
      action: "Neu anmelden",
    }
  }
  return null
}

/**
 * So lange darf authkit für seinen Start brauchen, bevor die Seite einen
 * Rückweg anbietet. Grosszügig: in echt ist der Client in Millisekunden da
 * (ein `setTimeout(…, 0)` plus ggf. ein Token-Roundtrip); wer hier wartet,
 * wartet in aller Regel für immer.
 */
export const AUTH_INIT_TIMEOUT_MS = 10_000

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading, signIn, getAccessToken, organizationId } = useAuth()
  const [signInError, setSignInError] = useState<string | null>(null)
  /**
   * Grund statt Flag: `null` = kein Ablauf. Das Overlay stellt die beiden
   * Ursachen unterschiedlich dar — ein blosses `true` hätte die im 401-Dauerfall
   * nachweislich falsche Diagnose „nicht erneuert" festgeschrieben.
   */
  const [expiredReason, setExpiredReason] = useState<SessionExpiredReason | null>(null)
  const sessionExpired = expiredReason !== null
  const [signInBlocked, setSignInBlocked] = useState(false)

  /**
   * Der Code-Tausch ist gescheitert: Die Seite kam mit einem `?code=` zurück,
   * authkit ist fertig — und trotzdem gibt es keinen Benutzer.
   *
   * authkit-js fängt den `CodeExchangeError` in `#handleCallback` ab, meldet
   * ihn NUR per `console.error`, geht in seinen ERROR-State und lässt `user`
   * auf `null`. Ohne diesen Abgleich sieht der Auto-signIn unten einen ganz
   * normalen „nicht angemeldet"-Zustand und leitet sofort wieder um:
   * Redirect → Exchange scheitert → Redirect. Genau diese Schleife hat der
   * Nutzer als leere Seite gesehen.
   */
  const codeExchangeFailed = !isLoading && !user && wasAuthCallbackOnLoad()

  /**
   * Wachhund über den authkit-Start. LOAD-BEARING, weil `codeExchangeFailed`
   * oben an `!isLoading` hängt — und `isLoading` kann für immer `true` bleiben:
   * authkit-react 0.16.1 ruft `createClient(...).then(...)` OHNE `.catch()`,
   * `setState({ isLoading: false })` liegt ausschließlich im Erfolgspfad. Lehnt
   * `createClient` ab (z. B. `JSON.parse(stateParam)` in `#handleCallback` bei
   * einem abgeschnittenen `state`-Parameter — steht dort ausserhalb des
   * try/catch —, oder gesperrter Site-Storage in `getRefreshToken`), bleibt die
   * Seite ohne diesen Wachhund dauerhaft in der handlungslosen
   * „weiterleiten …"-Anzeige stehen: kein Guard greift, der Auto-signIn kehrt
   * bei `isLoading` sofort zurück, und ein Reload reproduziert denselben
   * Zustand, weil authkit die URL nicht mehr bereinigt hat.
   */
  const [authInitStalled, setAuthInitStalled] = useState(false)
  useEffect(() => {
    if (!isLoading) {
      setAuthInitStalled(false)
      return
    }
    const timer = setTimeout(() => setAuthInitStalled(true), AUTH_INIT_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [isLoading])

  /**
   * Notausgang für den hängenden Start: der Provider liefert dann noch seinen
   * NOOP-Client (`signIn: async () => {}`), ein Anmelde-Redirect ist von hier
   * aus also gar nicht möglich. Nur ein Neuladen ohne Query kommt da raus.
   */
  const restartPage = useCallback(() => reloadWithoutAuthParams(), [])

  /**
   * Spiegel von `sessionExpired` als Ref — LOAD-BEARING aus zwei Gründen:
   * er darf (wie `expectedOrg`) nicht in den useMemo-Deps von `auth` landen,
   * und er muss einen Wechsel der `apiFetch`-Instanz überleben. Ein
   * erfolgreicher Force-Refresh erzeugt in authkit-react ein neues
   * `user`-Objekt und damit eine neue Instanz; ein Latch im Closure von
   * `createApiFetch` wäre also genau im Schleifenfall wirkungslos.
   */
  const sessionExpiredRef = useRef(false)
  const isSessionExpired = useCallback(() => sessionExpiredRef.current, [])
  const markSessionExpired = useCallback((reason: SessionExpiredReason) => {
    // Der ZUERST gemeldete Grund gilt. Ein dauerhaft mit 401 antwortendes
    // Backend meldet direkt danach erneut — dann aber über die Bremse in
    // `refreshOnce`, die ohne jeden Refresh `terminal` liefert und damit
    // „refresh-failed" sagen würde. Das überschriebe die zutreffende Diagnose.
    if (sessionExpiredRef.current) return
    sessionExpiredRef.current = true
    setExpiredReason(reason)
  }, [])

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

  /**
   * Ein Redirect wurde in DIESEM Seitenaufruf bereits gestartet. Danach ist
   * die Seite auf dem Weg zu WorkOS — ein zweiter Aufruf würde nur einen
   * zweiten PKCE-Code-Verifier erzeugen und den ersten im sessionStorage
   * überschreiben. Der Zähler in `lib/auth-callback` sichert dieselbe Frage
   * ÜBER Seitenaufrufe hinweg ab; dieses Ref ist die Sicherung innerhalb
   * eines Aufrufs.
   */
  const redirectStarted = useRef(false)

  const redirectToSignIn = useCallback(() => {
    redirectStarted.current = true
    setSignInError(null)
    // Rücksprungziel mitgeben — sonst landet auch der stille Roundtrip auf `/`.
    signIn({ state: { returnTo: currentReturnTo(window.location) } }).catch((err: unknown) => {
      setSignInError(err instanceof Error ? err.message : String(err))
    })
  }, [signIn])

  /**
   * Vom Nutzer ausgelöste Anmeldung (Buttons). Setzt den Schleifenzähler
   * zurück: ein bewusster Klick ist der Beleg, dass hier kein Automatismus
   * im Kreis läuft.
   */
  const startSignIn = useCallback(() => {
    resetSignInAttempts()
    setSignInBlocked(false)
    redirectToSignIn()
  }, [redirectToSignIn])

  useEffect(() => {
    // Erfolgreich angemeldet — die Serie ist beendet.
    if (user) resetSignInAttempts()
  }, [user])

  useEffect(() => {
    if (isLoading || user || redirectStarted.current) return
    // Jeder dieser Zustände hat ein eigenes Handlungsangebot im Bild; ein
    // automatischer Redirect würde es überfahren.
    if (signInError || sessionExpired || codeExchangeFailed || signInBlocked) return
    // Schleifenschutz: nach zu vielen Redirects in Folge wird der Zustand
    // sichtbar gemacht, statt erneut umzuleiten.
    if (!registerSignInAttempt()) {
      setSignInBlocked(true)
      return
    }
    redirectToSignIn()
  }, [
    isLoading,
    user,
    signInError,
    sessionExpired,
    codeExchangeFailed,
    signInBlocked,
    redirectToSignIn,
  ])

  // Bridge für `onRefreshFailure` am AuthKitProvider (hängt außerhalb des Routers).
  useEffect(
    // `onRefreshFailure` feuert genau dann, wenn der Refresh selbst gescheitert
    // ist — der zweite Grund kann von dort nicht kommen.
    () => subscribeSessionExpired(() => markSessionExpired("refresh-failed")),
    [markSessionExpired],
  )

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
      // Eine Org-Abweichung wird protokolliert, blockiert den Rückweg aber
      // NICHT: der Refresh hat funktioniert, die Sitzung ist gültig, und über
      // die Organisation entscheidet der Server (403 UNKNOWN_ORG → TenantGate).
      // Vorher endete genau hier ein `return false` — das Overlay war damit
      // unentrinnbar, obwohl die App dahinter normal bedienbar blieb.
      warnOnOrganizationDrift(token, expectedOrg.current)
      // Freigabe der 401-Bremse in `createApiFetch` — ab hier darf ein
      // weiterer 401 wieder einen Force-Refresh auslösen.
      sessionExpiredRef.current = false
      setExpiredReason(null)
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
            onSessionExpired: markSessionExpired,
            isSessionExpired,
          }
        : null,
    [user, getAccessToken, getExpectedOrganizationId, markSessionExpired, isSessionExpired],
  )
  const apiFetch = useMemo(() => createApiFetch(auth), [auth])

  if (!user) {
    // Ohne User gibt es keinen State mehr zu schützen — statt des Overlays
    // hier der Vollbild-Hinweis, damit kein Fehlerzustand in einer
    // handlungslosen „weiterleiten …"-Anzeige endet (der Auto-signIn ist in
    // all diesen Zuständen bewusst aus).
    const notice = signInNotice({
      signInError,
      authInitStalled,
      codeExchangeFailed,
      signInBlocked,
      sessionExpired,
    })
    return (
      <div className="flex min-h-screen items-center justify-center">
        {notice ? (
          <div className="w-full max-w-md space-y-4 px-6">
            <MnAlert label={notice.label}>{notice.text}</MnAlert>
            <Button onClick={notice.restart ? restartPage : startSignIn}>{notice.action}</Button>
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
      {expiredReason ? (
        <SessionExpiredOverlay
          reason={expiredReason}
          onRetry={retrySession}
          onSignIn={startSignIn}
          error={signInError}
        />
      ) : null}
    </ApiFetchContext.Provider>
  )
}
