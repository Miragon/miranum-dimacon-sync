/**
 * Drei Sicherungen um den PKCE-Roundtrip herum, alle bewusst React-frei und
 * damit direkt testbar:
 *
 * 1. Ein Marker, der beim MODUL-LOAD festhält, ob diese Seite als
 *    Auth-Callback (`?code=…`) geladen wurde.
 * 2. Ein Zähler über den `sessionStorage`, der verhindert, dass der
 *    automatische Anmelde-Redirect endlos feuert.
 * 3. Ein Notausgang, der den Seitenaufruf ohne Query-String neu startet —
 *    für den Fall, dass authkit gar nicht erst fertig wird.
 */

/**
 * Wurde diese Seite mit einem `?code=` aus WorkOS geladen?
 *
 * LOAD-BEARING, dass das beim Modul-Load passiert und nicht im Render:
 * authkit-js räumt die URL in `#handleCallback` selbst auf — `cleanUrl.search
 * = ""` + `window.history.replaceState` stehen dort AUSSERHALB des
 * try/catch, laufen also auch dann, wenn der Code-Tausch scheitert
 * (authkit-js 0.20.0, `src/create-client.ts`). Der Aufruf hängt am
 * `AuthKitProvider`-Effekt (`createClient` → `initialize`), passiert damit
 * NACH dem ersten Render — zum Zeitpunkt, an dem der AuthGate den
 * Fehlerzustand auswerten will, ist `window.location.search` längst leer.
 *
 * Der Marker ist absichtlich grob (nur `code`): der einzige Grund, aus dem
 * diese App ein `code` im Query-String hätte, ist der AuthKit-Rücksprung.
 */
function readAuthCallbackMarker(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("code")
  } catch {
    // Kein DOM (SSR/Node-Test): dann gab es auch keinen Callback.
    return false
  }
}

const AUTH_CALLBACK_ON_LOAD = readAuthCallbackMarker()

/**
 * `true`, wenn der Seitenaufruf ein Auth-Callback war. Bleibt für die
 * Lebensdauer des Dokuments stehen — ist danach trotzdem kein Benutzer da,
 * ist der Code-Tausch gescheitert (authkit-js meldet das nur per
 * `console.error` und lässt `user` auf `null`).
 */
export function wasAuthCallbackOnLoad(): boolean {
  return AUTH_CALLBACK_ON_LOAD
}

/** Schlüssel im `sessionStorage` — stirbt mit dem Tab, überlebt den Redirect. */
const ATTEMPTS_KEY = "miranum.auth.signin-attempts"

/**
 * So viele automatische Redirects in Folge sind erlaubt. Bewusst hoch
 * angesetzt: ein normaler Login braucht genau EINEN, ein stiller Roundtrip
 * nach einem Reload ebenfalls — und nach jedem Erfolg setzt der AuthGate den
 * Zähler ohnehin zurück. Lieber zu spät greifen als einen funktionierenden
 * Login blockieren; eine echte Schleife läuft im Sekundentakt und ist damit
 * nach wenigen Sekunden gestoppt.
 */
export const MAX_AUTO_SIGN_IN_ATTEMPTS = 5

/**
 * Zwei Versuche gehören zur selben Serie, wenn zwischen ihnen weniger als
 * diese Zeitspanne liegt. Gemessen wird der Abstand zum LETZTEN Versuch, nicht
 * zum ersten — sonst entkommt eine langsame Schleife dem Zähler, indem das
 * Fenster regelmäßig abläuft.
 */
const ATTEMPT_GAP_MS = 60_000

interface SignInAttempts {
  count: number
  last: number
}

function readAttempts(): SignInAttempts | null {
  try {
    const raw = sessionStorage.getItem(ATTEMPTS_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const { count, last } = parsed as { count?: unknown; last?: unknown }
    if (typeof count !== "number" || typeof last !== "number") return null
    if (!Number.isFinite(count) || !Number.isFinite(last)) return null
    return { count, last }
  } catch {
    // Storage gesperrt oder kaputter Eintrag: als „kein Versuch" behandeln.
    return null
  }
}

function writeAttempts(attempts: SignInAttempts): void {
  try {
    sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts))
  } catch {
    /* Storage gesperrt (Private Mode, Quota) — der Schutz entfällt still. */
  }
}

/** Nach einer erfolgreichen Anmeldung und bei jeder bewussten Nutzer-Aktion. */
export function resetSignInAttempts(): void {
  try {
    sessionStorage.removeItem(ATTEMPTS_KEY)
  } catch {
    /* s. o. */
  }
}

/**
 * Zählt einen automatischen Anmelde-Redirect und meldet, ob er stattfinden
 * darf. `false` heißt: zu viele Versuche in Folge — der Aufrufer muss einen
 * Fehlerzustand zeigen statt erneut umzuleiten.
 */
export function registerSignInAttempt(now: number = Date.now()): boolean {
  const previous = readAttempts()
  // `now < last` kann nur durch eine Uhrzeit-Korrektur entstehen — dann
  // beginnt eine neue Serie, statt den Zähler unbrauchbar zu machen.
  const sameSeries =
    previous !== null && now >= previous.last && now - previous.last <= ATTEMPT_GAP_MS
  const count = sameSeries ? previous.count + 1 : 1
  writeAttempts({ count, last: now })
  return count <= MAX_AUTO_SIGN_IN_ATTEMPTS
}

/** Das Minimum an `window`, das der Neustart unten braucht — so ist er testbar. */
interface ReloadTarget {
  location: Pick<Location, "href" | "replace" | "reload">
}

/**
 * Notausgang aus einem hängengebliebenen Seitenaufruf: Query-String weg, Seite
 * neu laden.
 *
 * Gebraucht wird das, wenn `createClient` in authkit-react ablehnt — der
 * Provider hat dafür KEIN `.catch()`, `isLoading` bleibt dann für immer `true`
 * und die App steht in der handlungslosen „weiterleiten …"-Anzeige. Ein
 * einfacher Reload hilft nicht, weil der Auslöser typischerweise in der URL
 * steckt (z. B. ein abgeschnittener `state`-Parameter: `#handleCallback` ruft
 * `JSON.parse(stateParam)` AUSSERHALB seines try/catch, authkit-js 0.20.0) —
 * und die Bereinigung der URL am Ende von `#handleCallback` nie erreicht
 * wurde. Erst ohne Query beginnt der Anmeldevorgang wieder von vorn.
 */
export function reloadWithoutAuthParams(target: ReloadTarget = window): void {
  resetSignInAttempts()
  try {
    const url = new URL(target.location.href)
    url.search = ""
    const next = url.toString()
    // Gab es gar keinen Query-String, ist `next` mit der aktuellen Adresse
    // identisch — und `location.replace` wäre dann bei einem vorhandenen
    // Fragment (z. B. `/modules#dimacon-zugangsdaten`) laut HTML-Spec nur eine
    // Fragment-Navigation: gleiche URL ohne Fragment + Fragment non-null ⇒ kein
    // Reload, der Notausgang täte sichtbar nichts. Betrifft den Stall-Grund
    // „gesperrter Site-Storage", der ohne `?code=` auf jeder Route auftritt.
    if (next === target.location.href) target.location.reload()
    else target.location.replace(next)
  } catch {
    // Keine parsbare Adresse: der einfache Reload ist immer noch besser als
    // eine Seite ohne jeden Rückweg.
    target.location.reload()
  }
}
