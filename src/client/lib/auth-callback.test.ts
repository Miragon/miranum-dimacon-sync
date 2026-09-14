// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  MAX_AUTO_SIGN_IN_ATTEMPTS,
  registerSignInAttempt,
  reloadWithoutAuthParams,
  resetSignInAttempts,
} from "./auth-callback"

/**
 * Lädt das Modul mit einer bestimmten Adresse NEU. Der Marker wird beim
 * Modul-Load gelesen — genau darum geht es: authkit-js räumt `?code=` per
 * `history.replaceState` weg, bevor React den Zustand auswerten kann.
 */
async function loadWithUrl(url: string) {
  vi.resetModules()
  window.history.replaceState({}, "", url)
  return await import("./auth-callback")
}

beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState({}, "", "/")
})

describe("wasAuthCallbackOnLoad", () => {
  it("erkennt den PKCE-Rücksprung am `code`-Parameter", async () => {
    const mod = await loadWithUrl("/sync/dimacon-clockin?code=abc123&state=%7B%7D")
    expect(mod.wasAuthCallbackOnLoad()).toBe(true)
  })

  it("meldet einen normalen Seitenaufruf nicht als Rücksprung", async () => {
    const mod = await loadWithUrl("/sync/dimacon-clockin?tab=zeitplan")
    expect(mod.wasAuthCallbackOnLoad()).toBe(false)
  })

  /**
   * DER eigentliche Grund für dieses Modul: authkit-js führt am Ende von
   * `#handleCallback` ein `cleanUrl.search = ""` + `history.replaceState`
   * aus — ausserhalb des try/catch, also auch bei gescheitertem Code-Tausch
   * (authkit-js 0.20.0, `src/create-client.ts`). Wer den Marker erst im
   * Render liest, sieht nur noch eine saubere URL.
   */
  it("hält den Befund fest, nachdem authkit die URL bereinigt hat", async () => {
    const mod = await loadWithUrl("/sync?code=abc123")
    // Exakt das, was authkit-js tut:
    window.history.replaceState({}, "", "/sync")
    expect(window.location.search).toBe("")
    expect(mod.wasAuthCallbackOnLoad()).toBe(true)
  })
})

describe("registerSignInAttempt", () => {
  it("lässt einen normalen Login (genau ein Redirect) durch", () => {
    expect(registerSignInAttempt()).toBe(true)
  })

  it("lässt den stillen Roundtrip nach einem Reload durch", () => {
    // Reload → ein Versuch, Erfolg → Zurücksetzen. Beliebig oft wiederholbar.
    for (let i = 0; i < 20; i++) {
      expect(registerSignInAttempt()).toBe(true)
      resetSignInAttempts()
    }
  })

  it("stoppt die Schleife nach wenigen Versuchen in Folge", () => {
    const start = 1_700_000_000_000
    // Eine echte Schleife dreht im Sekundentakt.
    for (let i = 0; i < MAX_AUTO_SIGN_IN_ATTEMPTS; i++) {
      expect(registerSignInAttempt(start + i * 1_000)).toBe(true)
    }
    expect(registerSignInAttempt(start + MAX_AUTO_SIGN_IN_ATTEMPTS * 1_000)).toBe(false)
    // Und bleibt gestoppt, ohne dass jemand eingreift.
    expect(registerSignInAttempt(start + (MAX_AUTO_SIGN_IN_ATTEMPTS + 1) * 1_000)).toBe(false)
  })

  /**
   * Gemessen wird der Abstand zum LETZTEN Versuch, nicht zum ersten — sonst
   * entkäme eine langsame Schleife dem Zähler, indem das Fenster zwischendurch
   * abläuft.
   */
  it("erwischt auch eine langsame Schleife", () => {
    const start = 1_700_000_000_000
    for (let i = 0; i < MAX_AUTO_SIGN_IN_ATTEMPTS; i++) {
      expect(registerSignInAttempt(start + i * 30_000)).toBe(true)
    }
    expect(registerSignInAttempt(start + MAX_AUTO_SIGN_IN_ATTEMPTS * 30_000)).toBe(false)
  })

  it("beginnt nach einer längeren Pause eine neue Serie", () => {
    const start = 1_700_000_000_000
    for (let i = 0; i < MAX_AUTO_SIGN_IN_ATTEMPTS; i++) {
      registerSignInAttempt(start + i * 1_000)
    }
    expect(registerSignInAttempt(start + 10 * 60_000)).toBe(true)
  })

  it("gibt nach `resetSignInAttempts` wieder frei", () => {
    const start = 1_700_000_000_000
    for (let i = 0; i <= MAX_AUTO_SIGN_IN_ATTEMPTS; i++) registerSignInAttempt(start + i * 1_000)
    expect(registerSignInAttempt(start + 10_000)).toBe(false)

    resetSignInAttempts()
    expect(registerSignInAttempt(start + 11_000)).toBe(true)
  })

  it("überlebt einen kaputten Eintrag im sessionStorage", () => {
    sessionStorage.setItem("miranum.auth.signin-attempts", "kein json")
    expect(registerSignInAttempt()).toBe(true)
  })

  /** Uhrzeit-Korrektur: lieber eine neue Serie als ein unbrauchbarer Zähler. */
  it("beginnt bei einem Zeitsprung rückwärts neu", () => {
    const start = 1_700_000_000_000
    for (let i = 0; i <= MAX_AUTO_SIGN_IN_ATTEMPTS; i++) registerSignInAttempt(start + i * 1_000)
    expect(registerSignInAttempt(start - 60_000)).toBe(true)
  })
})

/**
 * Notausgang aus einem Seitenaufruf, in dem authkit gar nicht fertig wird.
 * Ein einfacher Reload genügt NICHT: der Auslöser steckt typischerweise in der
 * URL (z. B. ein abgeschnittener `state`-Parameter, an dem `#handleCallback`
 * ausserhalb seines try/catch scheitert) — und weil die Funktion dort nie bis
 * zur URL-Bereinigung kommt, bliebe der Parameter stehen.
 */
describe("reloadWithoutAuthParams", () => {
  function fakeTarget(href: string) {
    return { location: { href, replace: vi.fn(), reload: vi.fn() } }
  }

  it("lädt die Seite ohne Query neu", () => {
    const target = fakeTarget("https://app.example.com/sync?code=abc123&state=kaputt")

    reloadWithoutAuthParams(target)

    expect(target.location.replace).toHaveBeenCalledWith("https://app.example.com/sync")
    expect(target.location.reload).not.toHaveBeenCalled()
  })

  it("behält den Pfad und den Fragment-Teil", () => {
    const target = fakeTarget("https://app.example.com/sync/dimacon-clockin?code=x#oben")

    reloadWithoutAuthParams(target)

    expect(target.location.replace).toHaveBeenCalledWith(
      "https://app.example.com/sync/dimacon-clockin#oben",
    )
  })

  it("gibt dem neuen Seitenaufruf das volle Redirect-Kontingent zurück", () => {
    for (let i = 0; i < MAX_AUTO_SIGN_IN_ATTEMPTS; i++) registerSignInAttempt()
    expect(registerSignInAttempt()).toBe(false)

    reloadWithoutAuthParams(fakeTarget("https://app.example.com/?code=abc"))

    expect(registerSignInAttempt()).toBe(true)
  })

  it("lädt notfalls einfach neu, wenn die Adresse nicht parsbar ist", () => {
    const target = fakeTarget("kein:// gültiger url")

    reloadWithoutAuthParams(target)

    expect(target.location.reload).toHaveBeenCalledTimes(1)
  })
})
