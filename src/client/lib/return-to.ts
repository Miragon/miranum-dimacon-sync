/**
 * Rücksprungziel über den PKCE-Roundtrip retten: `signIn({ state: { returnTo } })`
 * schickt den Pfad mit, `onRedirectCallback` liest ihn zurück.
 */

/** Aktueller In-App-Pfad inkl. Query (Default-Aufruf mit `window.location`). */
export function currentReturnTo(loc: { pathname: string; search: string }): string {
  return `${loc.pathname}${loc.search}`
}

/**
 * Validiert das zurückgereichte `state`. Der Wert kommt als JSON aus dem
 * Query-String von WorkOS zurück und ist damit angreifer-beeinflussbar —
 * ohne diese Prüfung wäre der Rücksprung ein Open Redirect. Erlaubt sind
 * NUR app-interne Pfade: Beginn `/`, aber nicht `//` oder `/\` (beides
 * protokollrelative URLs) und kein Schema vor dem ersten `/`.
 * `/` selbst liefert `null` — dorthin muss nicht navigiert werden.
 */
export function safeReturnTo(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null
  const raw = (state as { returnTo?: unknown }).returnTo
  if (typeof raw !== "string") return null
  if (!raw.startsWith("/")) return null
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null
  if (raw === "/") return null
  return raw
}
