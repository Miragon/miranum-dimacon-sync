import { AuthKitError } from "@workos-inc/authkit-react"
import { createContext, useContext } from "react"

export interface AuthTokenContext {
  /** Signatur von authkit `getAccessToken` — `forceRefresh` erzwingt einen Refresh. */
  getToken: (opts?: { forceRefresh?: boolean }) => Promise<string>
  /**
   * Signal (KEIN Redirect): die Session ist endgültig abgelaufen. Der AuthGate
   * zeigt daraufhin ein Overlay — offene Formulareingaben bleiben erhalten.
   */
  onSessionExpired: () => void
}

export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>

export const ApiFetchContext = createContext<ApiFetch | null>(null)

/**
 * Liest eine JSON-Antwort. Nötig, weil `res.json()` bei leerem Body mit
 * "Unexpected end of JSON input" abbricht und damit die eigentliche Ursache
 * verdeckt — typischerweise ein nicht laufendes Backend, für das der
 * Vite-Proxy einen leeren 500er liefert.
 */
export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()

  if (text.trim() === "") {
    throw new Error(
      res.ok
        ? `Leere Antwort vom Server (HTTP ${res.status})`
        : `Keine Antwort vom Backend (HTTP ${res.status}) — läuft der Server?`,
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    const snippet = text.slice(0, 120).replace(/\s+/g, " ").trim()
    throw new Error(`Ungültige JSON-Antwort (HTTP ${res.status}): ${snippet}`)
  }
}

/** Frische Headers je Versuch — ein wiederholter Request darf nie das alte Token tragen. */
function withAuthHeaders(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)
  return { ...init, headers }
}

/**
 * Ein Stream-Body ist nach dem ersten Versuch verbraucht — ein zweiter
 * Request würde stillschweigend leer rausgehen.
 */
function isReplayable(init: RequestInit | undefined): boolean {
  return !(init?.body instanceof ReadableStream)
}

/**
 * Trennt „Session endgültig weg" von „gerade kein Netz". authkit-js mappt NUR
 * seinen eigenen `RefreshError` (= HTTP-Antwort mit `!response.ok`) auf
 * `LoginRequiredError`; ein roher `TypeError` aus dem fetch (offline, DNS,
 * WorkOS kurz weg) und der `LockError` des Tab-übergreifenden Refresh-Locks
 * werden unverändert durchgereicht — und authkit selbst behandelt genau die
 * als transient (State zurück auf AUTHENTICATED).
 *
 * LOAD-BEARING: ohne diese Unterscheidung sperrt ein 3-Sekunden-WLAN-Aussetzer
 * die App hinter dem Abgelaufen-Overlay, obwohl die Session intakt ist.
 * Spiegelbild zu `TOKEN_INVALID_CODES` in `src/server/lib/auth.ts`, wo der
 * Server aus demselben Grund `invalid` von `unavailable` trennt.
 *
 * `err.name` taugt NICHT als Kriterium — `AuthKitError` und Ableitungen
 * setzen `name` nicht und heißen darum alle schlicht "Error".
 */
export function isSessionTerminal(err: unknown): boolean {
  return err instanceof AuthKitError
}

/** Transienter Fehler: normales Fehlerbanner der Seite statt Re-Login. */
function transientAuthError(cause: unknown): Error {
  return new Error("Anmeldedienst nicht erreichbar — bitte erneut versuchen", { cause })
}

/**
 * Ergebnis eines erzwungenen Refresh. `terminal` entscheidet, ob der Aufrufer
 * das Abgelaufen-Signal geben darf oder nur einen transienten Fehler meldet.
 */
type RefreshResult = { ok: true; token: string } | { ok: false; terminal: boolean; cause: unknown }

/**
 * Fabrik für den authentifizierten Fetch — bewusst React-frei und damit
 * direkt testbar. Ein 401 löst KEINEN Redirect mehr aus, sondern erst einen
 * einmaligen Force-Refresh mit Retry und, wenn auch das scheitert, das
 * `onSessionExpired`-Signal.
 *
 * Das `pendingRefresh`-Closure ist load-bearing: mehrere parallele 401
 * (z. B. /api/me + /api/tenants) müssen sich EINEN Refresh teilen. Ohne
 * Dedup erzeugt jeder Reauth-Versuch einen neuen PKCE-Code-Verifier und
 * überschreibt den vorherigen im sessionStorage. Nebenbei löst der
 * erzwungene Refresh die Sackgasse in authkit-js: `getAccessToken` prüft
 * `options?.forceRefresh ||` VOR `#shouldRefresh()`, das im ERROR-State
 * dauerhaft `false` liefert.
 */
export function createApiFetch(auth: AuthTokenContext | null): ApiFetch {
  let pendingRefresh: Promise<RefreshResult> | null = null

  function refreshOnce(): Promise<RefreshResult> {
    if (!auth) return Promise.resolve({ ok: false, terminal: true, cause: null })
    // LOAD-BEARING: das `= null` im finally macht den Single-Flight-Slot wieder
    // frei. Ohne das liefert jeder spätere Zyklus dasselbe (längst veraltete)
    // Ergebnis — apiFetch lebt über `useMemo` die ganze Sitzung lang.
    pendingRefresh ??= auth
      .getToken({ forceRefresh: true })
      .then<RefreshResult, RefreshResult>(
        (token) => ({ ok: true, token }),
        (cause: unknown) => ({ ok: false, terminal: isSessionTerminal(cause), cause }),
      )
      .finally(() => {
        pendingRefresh = null
      })
    return pendingRefresh
  }

  return async function apiFetch(input, init) {
    if (!auth) return fetch(input, init)

    let token: string
    try {
      token = await auth.getToken()
    } catch (err) {
      // Netzfehler/Lock-Timeout: Session unangetastet lassen, Fehler melden.
      if (!isSessionTerminal(err)) throw transientAuthError(err)

      // authkit wirft LoginRequiredError, wenn der Refresh scheitert —
      // einmal erzwingen, bevor die Session als abgelaufen gilt.
      const refreshed = await refreshOnce()
      if (!refreshed.ok && !refreshed.terminal) throw transientAuthError(refreshed.cause)
      if (!refreshed.ok) {
        auth.onSessionExpired()
        throw new Error("Sitzung abgelaufen — bitte neu anmelden")
      }
      token = refreshed.token
    }

    const res = await fetch(input, withAuthHeaders(init, token))
    // 401 trotz Token: einmal refreshen und den Request wiederholen.
    // 403 (falsche Organisation) bleibt ein normaler Fehler — Re-Login hilft nicht.
    if (res.status !== 401 || !isReplayable(init)) return res

    const fresh = await refreshOnce()
    if (!fresh.ok) {
      // Nur ein echter authkit-Fehler beweist, dass die Session weg ist; bei
      // einem Netzfehler bleibt es beim normalen 401-Fehlerbild der Seite.
      if (fresh.terminal) auth.onSessionExpired()
      // Original-Response zurück, Body ungelesen — readJson des Aufrufers bleibt intakt.
      return res
    }

    const retry = await fetch(input, withAuthHeaders(init, fresh.token))
    if (retry.status === 401) auth.onSessionExpired()
    return retry
  }
}

/** Auth aus (Dev): ein Modul-Singleton, damit die Identität stabil bleibt. */
const FALLBACK_FETCH = createApiFetch(null)

export function useApiFetch(): ApiFetch {
  return useContext(ApiFetchContext) ?? FALLBACK_FETCH
}
