import { LoginRequiredError } from "@workos-inc/authkit-react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApiFetch, readJson } from "./api"

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
  onSessionExpired: ReturnType<typeof vi.fn>
}

/**
 * Token-Quelle wie authkit: ohne Argument das Bestandstoken, mit forceRefresh
 * ein frisches. `expectedOrg` bleibt per Default `null` — dann ist die
 * Organisationsprüfung aus und die Tests messen nur den Refresh-Pfad.
 */
function authStub(getToken?: AuthStub["getToken"], expectedOrg: string | null = null): AuthStub {
  return {
    getToken:
      getToken ??
      vi.fn(async (opts?: { forceRefresh?: boolean }) => (opts?.forceRefresh ? "new" : "old")),
    getExpectedOrganizationId: () => expectedOrg,
    onSessionExpired: vi.fn(),
  }
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
    const forced = auth.getToken.mock.calls.filter(
      (c) => (c[0] as { forceRefresh?: boolean } | undefined)?.forceRefresh,
    )
    expect(forced).toHaveLength(1)
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
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // #5: authkit löscht beim RefreshError zusammen mit dem Token auch die
  // gespeicherte Organisation. Ein danach erzwungener Refresh geht ohne
  // `organization_id` raus und kann ein Token einer FREMDEN Organisation
  // liefern — das darf nie still als geheilte Sitzung durchgehen.
  it("refuses a refreshed token that belongs to another organization", async () => {
    fetchMock.mockResolvedValue(response('{"ok":true}', { status: 200 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) => {
        if (!opts?.forceRefresh) throw new LoginRequiredError()
        return jwtFor("org_fremd")
      }),
      "org_original",
    )

    await expect(createApiFetch(auth)("/api/me")).rejects.toThrow(/anderen Organisation/)
    // Kein Request mit dem fremden Token — sonst arbeitete die UI im falschen
    // Mandanten weiter, ohne dass es jemand merkt.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(auth.onSessionExpired).toHaveBeenCalledTimes(1)
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

  it("does not block an undecodable token — the server is the real gate", async () => {
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

  // Derselbe Guard auf dem 401-Replay-Pfad. In Produktion entsteht die
  // Abweichung dort nicht (authkit liest die Org aus dem noch vorhandenen
  // Memory-Token) — der Test isoliert den Guard, nicht das Szenario.
  it("does not replay a 401 with a token of another organization", async () => {
    fetchMock.mockResolvedValue(response("", { status: 401 }))
    const auth = authStub(
      vi.fn(async (opts?: { forceRefresh?: boolean }) =>
        opts?.forceRefresh ? jwtFor("org_fremd") : "old",
      ),
      "org_original",
    )

    const res = await createApiFetch(auth)("/api/me")

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.onSessionExpired).toHaveBeenCalledTimes(1)
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

    // Nach einem erfolgreichen Refresh (z. B. über „Erneut versuchen") muss
    // derselbe apiFetch wieder durchkommen.
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
