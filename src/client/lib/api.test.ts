import { LoginRequiredError } from "@workos-inc/authkit-react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApiFetch, readJson, type SessionExpiredReason } from "./api"

/** Genau das, was ein fehlgeschlagenes `fetch` wirft — offline, DNS, WorkOS kurz weg. */
function networkError(): TypeError {
  return new TypeError("Failed to fetch")
}

function response(body: string, init?: ResponseInit): Response {
  return new Response(body, init)
}

describe("readJson", () => {
  it("parses a normal JSON body", async () => {
    await expect(readJson(response('{"ok":true}'))).resolves.toEqual({ ok: true })
  })

  it("reports an unreachable backend instead of 'Unexpected end of JSON input'", async () => {
    // Exakt was der Vite-Proxy liefert, wenn auf Port 3020 nichts läuft:
    // 502 Bad Gateway mit 0 Byte Body.
    const err = await readJson(response("", { status: 502 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Keine Antwort vom Backend \(HTTP 502\)/)
    expect((err as Error).message).not.toMatch(/Unexpected end of JSON input/)
  })

  it("flags an empty body on an otherwise successful response", async () => {
    await expect(readJson(response("", { status: 200 }))).rejects.toThrow(
      /Leere Antwort vom Server \(HTTP 200\)/,
    )
  })

  it("treats a whitespace-only body as empty", async () => {
    await expect(readJson(response("   \n  ", { status: 200 }))).rejects.toThrow(/Leere Antwort/)
  })

  it("includes a snippet when the body is not JSON (e.g. an HTML error page)", async () => {
    const err = await readJson(
      response("<!doctype html><html><body>502 Bad Gateway</body></html>", { status: 502 }),
    ).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/Ungültige JSON-Antwort \(HTTP 502\)/)
    expect((err as Error).message).toMatch(/502 Bad Gateway/)
  })

  it("truncates a long non-JSON body", async () => {
    const err = await readJson(response("x".repeat(500), { status: 500 })).catch((e: unknown) => e)
    expect((err as Error).message.length).toBeLessThan(200)
  })

  it("returns the parsed error payload for a JSON error response", async () => {
    // res.ok wird von den Aufrufern geprüft — readJson gibt den Body zurück.
    await expect(readJson(response('{"error":"boom"}', { status: 500 }))).resolves.toEqual({
      error: "boom",
    })
  })
})

interface AuthStub {
  getToken: ReturnType<typeof vi.fn>
  getExpectedOrganizationId: () => string | null
  onSessionExpired: ReturnType<typeof vi.fn<(reason: SessionExpiredReason) => void>>
  isSessionExpired: () => boolean
  /** Simuliert „Erneut versuchen" im Overlay: der Abgelaufen-Zustand fällt. */
  release: () => void
}

/**
 * Token-Quelle wie authkit: ohne Argument das Bestandstoken, mit forceRefresh
 * ein frisches. `expectedOrg` bleibt per Default `null` — dann ist die
 * Organisationsprüfung aus und die Tests messen nur den Refresh-Pfad.
 *
 * `isSessionExpired` spiegelt wie im AuthGate den Zustand, den
 * `onSessionExpired` setzt — in echt ein Ref, der einen Wechsel der
 * apiFetch-Instanz überlebt.
 */
function authStub(getToken?: AuthStub["getToken"], expectedOrg: string | null = null): AuthStub {
  let expired = false
  return {
    getToken:
      getToken ??
      vi.fn(async (opts?: { forceRefresh?: boolean }) => (opts?.forceRefresh ? "new" : "old")),
    getExpectedOrganizationId: () => expectedOrg,
    onSessionExpired: vi.fn((_reason: SessionExpiredReason) => {
      expired = true
    }),
    isSessionExpired: () => expired,
    release: () => {
      expired = false
    },
  }
}

/** Wie oft ist ein Refresh gegen WorkOS gefahren worden? */
function forcedRefreshCount(auth: AuthStub): number {
  return auth.getToken.mock.calls.filter(
    (c) => (c[0] as { forceRefresh?: boolean } | undefined)?.forceRefresh,
  ).length
}

function authHeaderOfCall(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit | undefined)?.headers).get("authorization")
}

/** Signaturloses JWT — `getClaims` dekodiert nur, es verifiziert nichts. */
function jwtFor(orgId: string | null): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${seg({ alg: "none" })}.${seg(orgId ? { org_id: orgId } : {})}.sig`
}

describe("createApiFetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("refreshes once and replays the request after a 401", async () => {
    fetchMock
      .mockResolvedValueOnce(response("", { status: 401 }))
      .mockResolvedValueOnce(response('{"ok":true}', { status: 200 }))
    const auth = authStub()

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(authHeaderOfCall(fetchMock.mock.calls[0])).toBe("Bearer old")
    expect(authHeaderOfCall(fetchMock.mock.calls[1])).toBe("Bearer new")
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })

  it("signals an expired session when the replay is a 401 again", async () => {
    fetchMock.mockResolvedValue(response("", { status: 401 }))
    const auth = authStub()

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.onSessionExpired).toHaveBeenCalledTimes(1)
    // LOAD-BEARING für den Text im Overlay: Der Refresh hat hier GEKLAPPT,
    // abgelehnt hat der Server. „Anmeldung nicht erneuert" wäre die falsche
    // Diagnose — genau so live gemessen (WorkOS 200, /api/* dauerhaft 401).
    expect(auth.onSessionExpired).toHaveBeenCalledWith("server-rejected")
  })

  it("returns the untouched original 401 when the refresh fails", async () => {
    fetchMock.mockResolvedValue(response('{"error":"invalid token"}', { status: 401 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (opts?.forceRefresh) throw new LoginRequiredError()
        return "old"
      }),
    )

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.onSessionExpired).toHaveBeenCalledTimes(1)
    // Hier ist der Refresh selbst gescheitert — andere Ursache, anderer Text.
    expect(auth.onSessionExpired).toHaveBeenCalledWith("refresh-failed")
    // Body wurde nie gelesen — readJson des Aufrufers funktioniert weiter.
    await expect(readJson(res)).resolves.toEqual({ error: "invalid token" })
  })

  it("deduplicates the refresh across parallel 401s (single flight)", async () => {
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === "Bearer new"
        ? response('{"ok":true}', { status: 200 })
        : response("", { status: 401 }),
    )
    const auth = authStub()
    const apiFetch = createApiFetch(auth)

    const results = await Promise.all([
      apiFetch("/api/me"),
      apiFetch("/api/tenants"),
      apiFetch("/api/systems"),
    ])

    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(forcedRefreshCount(auth)).toBe(1)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })

  it("recovers when the initial getToken throws but the forced refresh works", async () => {
    fetchMock.mockResolvedValue(response('{"ok":true}', { status: 200 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (!opts?.forceRefresh) throw new LoginRequiredError()
        return "new"
      }),
    )

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(200)
    expect(authHeaderOfCall(fetchMock.mock.calls[0])).toBe("Bearer new")
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })

  it("rejects with a German message when no token can be obtained at all", async () => {
    const auth = authStub(vi.fn(async () => Promise.reject(new LoginRequiredError())))

    await expect(createApiFetch(auth)("/api/me")).rejects.toThrow(/Sitzung abgelaufen/)
    expect(auth.onSessionExpired).toHaveBeenCalledTimes(1)
    expect(auth.onSessionExpired).toHaveBeenCalledWith("refresh-failed")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Eine abweichende Organisation ist KEIN Grund, die Sitzung zu beenden: die
  // beiden Werte stammen aus verschiedenen Quellen (useAuth-Response vs.
  // JWT-Claim) und können auseinanderlaufen, während die Sitzung gültig ist.
  // Eine frühere Fassung hat daraus `terminal: true` gemacht und die UI hinter
  // dem Overlay eingesperrt, obwohl jeder API-Call weiter funktionierte.
  // Über die Organisation entscheidet der Server (403 UNKNOWN_ORG).
  it("warns about a diverging organization but keeps the session alive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    fetchMock.mockResolvedValue(response('{"ok":true}', { status: 200 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (!opts?.forceRefresh) throw new LoginRequiredError()
        return jwtFor("org_fremd")
      }),
      "org_original",
    )

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(200)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("accepts a refreshed token of the same organization", async () => {
    fetchMock.mockResolvedValue(response('{"ok":true}', { status: 200 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (!opts?.forceRefresh) throw new LoginRequiredError()
        return jwtFor("org_original")
      }),
      "org_original",
    )

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(200)
    expect(authHeaderOfCall(fetchMock.mock.calls[0])).toBe(`Bearer ${jwtFor("org_original")}`)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })

  it("stays silent on an undecodable token — the server is the real gate", async () => {
    fetchMock.mockResolvedValue(response('{"ok":true}', { status: 200 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (!opts?.forceRefresh) throw new LoginRequiredError()
        return "kein-jwt"
      }),
      "org_original",
    )

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(200)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })

  // Auch auf dem 401-Replay-Pfad hält eine Org-Abweichung den Retry nicht auf.
  it("still replays a 401 when the organization diverges", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    fetchMock
      .mockResolvedValueOnce(response("", { status: 401 }))
      .mockResolvedValueOnce(response('{"ok":true}', { status: 200 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) =>
        opts?.forceRefresh ? jwtFor("org_fremd") : "old",
      ),
      "org_original",
    )

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("treats a 403 as a normal error — no refresh, no session signal", async () => {
    fetchMock.mockResolvedValue(response('{"code":"UNKNOWN_ORG"}', { status: 403 }))
    const auth = authStub()

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.getToken).toHaveBeenCalledTimes(1)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })

  it("stays passive without auth (dev mode): no bearer header, no replay", async () => {
    fetchMock.mockResolvedValue(response("", { status: 401 }))

    const res = await createApiFetch(null)("/api/me")

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(authHeaderOfCall(fetchMock.mock.calls[0])).toBeNull()
  })

  it("does not replay a request whose body is a stream", async () => {
    fetchMock.mockResolvedValue(response("", { status: 401 }))
    const auth = authStub()
    const body = new ReadableStream()

    const res = await createApiFetch(auth)("/api/upload", { method: "POST", body })

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Das `init` des Aufrufers muss BEIDE Versuche überleben — sonst ginge ein
  // PUT mit Cron-Body als körperloses GET raus, ohne dass ein Gate anschlägt.
  it("keeps method, body and custom headers on the original request and on the replay", async () => {
    fetchMock
      .mockResolvedValueOnce(response("", { status: 401 }))
      .mockResolvedValueOnce(response('{"ok":true}', { status: 200 }))
    const auth = authStub()
    const payload = '{"cron":"0 6 * * *"}'
    const controller = new AbortController()

    const res = await createApiFetch(auth)("/api/settings/integrations/dimacon-clockin", {
      method: "PUT",
      body: payload,
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit
      expect(init.method).toBe("PUT")
      expect(init.body).toBe(payload)
      expect(init.signal).toBe(controller.signal)
      expect(new Headers(init.headers).get("content-type")).toBe("application/json")
    }
  })

  // `pendingRefresh` wird im `finally` zurückgesetzt — ohne das liefert jeder
  // spätere Zyklus derselben (sitzungslangen) apiFetch-Instanz das alte Token.
  it("starts a fresh refresh for every later 401 cycle (single-flight slot is released)", async () => {
    let issued = 0
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (!opts?.forceRefresh) return "old"
        issued += 1
        return `new${String(issued)}`
      }),
    )
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === `Bearer new${String(issued)}`
        ? response('{"ok":true}', { status: 200 })
        : response("", { status: 401 }),
    )
    const apiFetch = createApiFetch(auth)

    expect((await apiFetch("/api/me")).status).toBe(200)
    expect((await apiFetch("/api/tenants")).status).toBe(200)

    expect(issued).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(authHeaderOfCall(fetchMock.mock.calls[1])).toBe("Bearer new1")
    expect(authHeaderOfCall(fetchMock.mock.calls[3])).toBe("Bearer new2")
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })

  it("is not pinned to a failed refresh — a later cycle recovers on the same instance", async () => {
    let attempt = 0
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (!opts?.forceRefresh) return "old"
        attempt += 1
        if (attempt === 1) throw new LoginRequiredError()
        return "new"
      }),
    )
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === "Bearer new"
        ? response('{"ok":true}', { status: 200 })
        : response("", { status: 401 }),
    )
    const apiFetch = createApiFetch(auth)

    expect((await apiFetch("/api/me")).status).toBe(401)
    expect(auth.onSessionExpired).toHaveBeenCalledTimes(1)

    // „Erneut versuchen" im Overlay gibt den Abgelaufen-Zustand frei; danach
    // muss derselbe apiFetch wieder durchkommen.
    auth.release()
    expect((await apiFetch("/api/me")).status).toBe(200)
    expect(attempt).toBe(2)
  })
})

/**
 * Transient ≠ abgelaufen. authkit-js mappt NUR seinen `RefreshError` auf
 * `LoginRequiredError`; ein roher `TypeError` aus dem fetch geht unverändert
 * durch. Würde der hier als „Session abgelaufen" gewertet, sperrte ein kurzer
 * WLAN-Aussetzer die App hinter dem nicht schließbaren Overlay.
 */
describe("createApiFetch — transiente Fehler", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reports a network failure of getToken as a transient error, not as an expired session", async () => {
    const auth = authStub(vi.fn(async () => Promise.reject(networkError())))

    const err = await createApiFetch(auth)("/api/me").catch((e: unknown) => e)

    expect((err as Error).message).toMatch(/Anmeldedienst nicht erreichbar/)
    expect((err as Error).message).not.toMatch(/Sitzung abgelaufen/)
    expect((err as Error).cause).toBeInstanceOf(TypeError)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    // Kein Force-Refresh: der Fehler sagt nichts über die Session aus.
    expect(auth.getToken).toHaveBeenCalledTimes(1)
  })

  it("reports a network failure of the forced refresh as transient too", async () => {
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (opts?.forceRefresh) throw networkError()
        throw new LoginRequiredError()
      }),
    )

    await expect(createApiFetch(auth)("/api/me")).rejects.toThrow(/Anmeldedienst nicht erreichbar/)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })

  it("keeps the plain 401 when the refresh fails for network reasons", async () => {
    fetchMock.mockResolvedValue(response('{"error":"invalid token"}', { status: 401 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (opts?.forceRefresh) throw networkError()
        return "old"
      }),
    )

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
    await expect(readJson(res)).resolves.toEqual({ error: "invalid token" })
  })
})

/**
 * REGRESSION (live gemessen): Alle `/api/*` antworten dauerhaft mit 401, die
 * Sitzung ist intakt. Beobachtet wurde im Sekundentakt und endlos:
 * 401 → Force-Refresh (200 von WorkOS) → Retry 401 → Force-Refresh → …
 * Der Refresh gelingt jedes Mal, der Retry scheitert jedes Mal. Bei einem
 * echten Backend-Ausfall reißt das das WorkOS-Rate-Limit.
 *
 * Der Motor der Schleife: ein erfolgreicher Refresh liefert authkit-react ein
 * neues `user`-Objekt (`isEquivalentWorkOSSession` vergleicht u. a. `roles`
 * per Referenz), der AuthGate baut eine neue apiFetch-Instanz, und jeder
 * Consumer mit `apiFetch` in den Hook-Deps lädt neu. Deshalb steht die Bremse
 * im AuthGate-Ref und nicht im Closure dieser Fabrik.
 */
describe("createApiFetch — kein Dauerfeuer nach dem Abgelaufen-Signal", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fährt nach dem ersten Signal keinen weiteren Refresh gegen WorkOS", async () => {
    fetchMock.mockResolvedValue(response('{"error":"unauthorized"}', { status: 401 }))
    const auth = authStub()
    const apiFetch = createApiFetch(auth)

    // Erster Zyklus: Refresh gelingt, der Retry scheitert trotzdem → Overlay.
    expect((await apiFetch("/api/me")).status).toBe(401)
    expect(forcedRefreshCount(auth)).toBe(1)
    expect(auth.onSessionExpired).toHaveBeenCalledTimes(1)

    // Ab hier darf WorkOS nicht mehr angefasst werden.
    expect((await apiFetch("/api/me")).status).toBe(401)
    expect((await apiFetch("/api/tenants")).status).toBe(401)
    expect((await apiFetch("/api/systems")).status).toBe(401)
    expect(forcedRefreshCount(auth)).toBe(1)
    // Der 401 bleibt unverändert beim Aufrufer — nur der Refresh entfällt.
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  /**
   * Die Bremse muss einen Instanz-Wechsel überleben — sonst greift sie genau
   * im Schleifenfall nicht, weil dort laufend neue Instanzen entstehen.
   */
  it("greift auch für eine frisch gebaute apiFetch-Instanz", async () => {
    fetchMock.mockResolvedValue(response("", { status: 401 }))
    const auth = authStub()

    expect((await createApiFetch(auth)("/api/me")).status).toBe(401)
    expect(forcedRefreshCount(auth)).toBe(1)

    expect((await createApiFetch(auth)("/api/me")).status).toBe(401)
    expect(forcedRefreshCount(auth)).toBe(1)
  })

  it("verhindert auch den Refresh, wenn schon `getToken` scheitert", async () => {
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (opts?.forceRefresh) return "new"
        throw new LoginRequiredError()
      }),
    )
    fetchMock.mockResolvedValue(response("", { status: 401 }))
    const apiFetch = createApiFetch(auth)

    // Erster Zyklus: zweimal Refresh (einmal für das fehlende Token, einmal
    // nach dem 401), der Request bleibt trotzdem 401 → Signal.
    expect((await apiFetch("/api/me")).status).toBe(401)
    expect(auth.onSessionExpired).toHaveBeenCalled()
    expect(forcedRefreshCount(auth)).toBe(2)

    // Danach kommt der Aufruf nicht einmal mehr bis zum fetch — und vor allem
    // nicht mehr bis WorkOS.
    await expect(apiFetch("/api/me")).rejects.toThrow(/Sitzung abgelaufen/)
    expect(forcedRefreshCount(auth)).toBe(2)
  })

  it("gibt den Weg nach einem erfolgreichen Retry wieder frei", async () => {
    fetchMock.mockResolvedValue(response("", { status: 401 }))
    const auth = authStub()
    const apiFetch = createApiFetch(auth)

    expect((await apiFetch("/api/me")).status).toBe(401)
    expect(forcedRefreshCount(auth)).toBe(1)

    auth.release()
    expect((await apiFetch("/api/me")).status).toBe(401)
    expect(forcedRefreshCount(auth)).toBe(2)
  })

  // Die Single-Flight-Mechanik bleibt unangetastet: solange kein Signal
  // gefallen ist, teilen sich parallele 401 weiterhin EINEN Refresh.
  it("lässt den Single-Flight-Slot unberührt, solange die Sitzung gilt", async () => {
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === "Bearer new"
        ? response('{"ok":true}', { status: 200 })
        : response("", { status: 401 }),
    )
    const auth = authStub()
    const apiFetch = createApiFetch(auth)

    const results = await Promise.all([apiFetch("/api/me"), apiFetch("/api/tenants")])

    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(forcedRefreshCount(auth)).toBe(1)
    expect(auth.onSessionExpired).not.toHaveBeenCalled()
  })
})
