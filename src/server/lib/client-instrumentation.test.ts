import { describe, expect, it, vi } from "vitest"
import {
  enrichClientError,
  instrumentHeyApiClient,
  parseRetryAfter,
  wrapLexofficeClient,
  type InterceptableClient,
  type ResponseLike,
} from "./client-instrumentation.js"
import { formatError } from "./errors.js"
import { isRateLimited, isTransient } from "./concurrency.js"
import { withRunMetrics, type RunMetricsSnapshot } from "./metrics.js"
import { createTokenBucket, type TokenBucket } from "./rate-limit.js"

function fakeResponse(
  status: number,
  headers: Record<string, string> = {},
  extra: Partial<ResponseLike> = {},
): ResponseLike {
  return {
    status,
    statusText: extra.statusText ?? "",
    url: extra.url,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  }
}

function fakeBucket(): TokenBucket & { pauses: number[] } {
  const pauses: number[] = []
  return {
    pauses,
    acquire: async () => undefined,
    pauseFor: (ms: number) => {
      pauses.push(ms)
    },
    stats: () => ({ tokens: 1, ratePerSec: 1, burst: 1, pausedForMs: 0 }),
  }
}

describe("parseRetryAfter", () => {
  it("liest Sekundenwerte", () => {
    expect(parseRetryAfter("3")).toBe(3_000)
    expect(parseRetryAfter(" 0.5 ")).toBe(500)
  })

  it("liest ein HTTP-Datum relativ zur Gegenwart", () => {
    const now = Date.parse("2026-01-01T12:00:00Z")
    expect(parseRetryAfter("Thu, 01 Jan 2026 12:00:07 GMT", now)).toBe(7_000)
  })

  it("deckelt auf 60 s", () => {
    expect(parseRetryAfter("600")).toBe(60_000)
  })

  it("verwirft nicht-positive Angaben statt sie auf 0 zu klemmen", () => {
    // Eine 0 würde beide Bremsen abschalten: pauseFor(0) ist ein No-op und
    // withRetry nähme die 0 als Server-Vorgabe (⇒ 5 Versuche ohne Pause).
    const now = Date.parse("2026-01-01T12:00:00Z")
    // Uhr-Drift: der Server meint "warte 60 s", unsere Uhr geht 60 s vor.
    expect(parseRetryAfter("Thu, 01 Jan 2026 11:59:00 GMT", now)).toBeUndefined()
    expect(parseRetryAfter("Thu, 01 Jan 2026 12:00:00 GMT", now)).toBeUndefined()
    expect(parseRetryAfter("0")).toBeUndefined()
    expect(parseRetryAfter("-5")).toBeUndefined()
  })

  it("liefert undefined ohne bzw. bei unbrauchbarem Header", () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter("")).toBeUndefined()
    expect(parseRetryAfter("bald")).toBeUndefined()
  })
})

describe("enrichClientError", () => {
  it("hängt Status, Retry-After und bereinigte URL an einen Objekt-Body", () => {
    const err = enrichClientError(
      { message: "Too Many Attempts." },
      fakeResponse(
        429,
        { "retry-after": "7" },
        {
          statusText: "Too Many Requests",
          url: "https://api.example.com/v3/projects?token=geheim",
        },
      ),
    )
    expect(err).toMatchObject({
      message: "Too Many Attempts.",
      status: 429,
      statusText: "Too Many Requests",
      retryAfterMs: 7_000,
      url: "https://api.example.com/v3/projects",
    })
    // Query-Strings (potenzielle Secrets) landen nie im Fehlerobjekt.
    expect(JSON.stringify(err)).not.toContain("geheim")
  })

  it("hebt String-Bodies zu einem Objekt mit message an", () => {
    const err = enrichClientError("Service Unavailable", fakeResponse(503))
    expect(err).toEqual({ message: "Service Unavailable", status: 503 })
    expect(formatError(err)).toBe("Service Unavailable")
    expect(isTransient(err)).toBe(true)
  })

  it("lässt Netzwerkfehler (ohne Response) unverändert", () => {
    const original = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
    expect(enrichClientError(original, undefined)).toBe(original)
  })

  it("pausiert den Bucket bei 429 — mit Retry-After bzw. mit Default", () => {
    const bucket = fakeBucket()
    enrichClientError({ message: "nope" }, fakeResponse(429, { "retry-after": "4" }), bucket)
    enrichClientError({ message: "nope" }, fakeResponse(429), bucket)
    enrichClientError({ message: "nope" }, fakeResponse(500), bucket)
    expect(bucket.pauses).toEqual([4_000, 2_000])
  })

  it("pausiert auch bei unbrauchbarem Retry-After die volle Default-Zeit", () => {
    const bucket = fakeBucket()
    const now = Date.parse("2026-01-01T12:00:00Z")
    const nullWert = enrichClientError(
      { message: "Too Many Attempts." },
      fakeResponse(429, { "retry-after": "0" }),
      bucket,
      now,
    )
    const vergangenheit = enrichClientError(
      { message: "Too Many Attempts." },
      fakeResponse(429, { "retry-after": "Thu, 01 Jan 2026 11:59:00 GMT" }),
      bucket,
      now,
    )

    expect(bucket.pauses).toEqual([2_000, 2_000])
    // Kein retryAfterMs am Fehler ⇒ withRetry nutzt die 5/10/20/30-s-Treppe.
    expect(nullWert).not.toHaveProperty("retryAfterMs")
    expect(vergangenheit).not.toHaveProperty("retryAfterMs")
  })

  it("macht 429/5xx für withRetry erkennbar, ohne die Meldung zu verändern", () => {
    const err = enrichClientError({ message: "Der Server hat Schluckauf" }, fakeResponse(429))
    expect(isRateLimited(err)).toBe(true)
    // formatError bleibt bei der Meldung des Bodys — keine Response-Details
    // und keine URL in nutzersichtbaren Texten.
    expect(formatError(err)).toBe("Der Server hat Schluckauf")
  })

  it("kommt mit eingefrorenen und leeren Bodies klar", () => {
    const frozen = Object.freeze({ message: "kaputt" })
    expect(enrichClientError(frozen, fakeResponse(400))).toEqual({ message: "kaputt", status: 400 })
    expect(enrichClientError("", fakeResponse(404, {}, { statusText: "Not Found" }))).toEqual({
      status: 404,
      statusText: "Not Found",
    })
  })
})

describe("instrumentHeyApiClient", () => {
  function fakeClient() {
    const request: ((req: Request, options: unknown) => Request | Promise<Request>)[] = []
    const error: ((
      err: unknown,
      res: Response | undefined,
      req: Request,
      options: unknown,
    ) => unknown)[] = []
    const client: InterceptableClient = {
      interceptors: {
        request: { use: (fn) => request.push(fn) },
        error: { use: (fn) => error.push(fn) },
      },
    }
    return { client, request, error }
  }

  it("drosselt, zählt und gibt den Request unverändert zurück", async () => {
    const { client, request } = fakeClient()
    const bucket = fakeBucket()
    const acquire = vi.spyOn(bucket, "acquire")
    instrumentHeyApiClient(client, "clockin", bucket)

    const original = new Request("https://api.example.com/v3/projects")
    let snapshot: RunMetricsSnapshot | undefined
    await withRunMetrics(
      async () => {
        expect(await request[0]!(original, {})).toBe(original)
      },
      (s) => (snapshot = s),
    )

    expect(acquire).toHaveBeenCalledTimes(1)
    expect(snapshot?.requests).toEqual({ dimacon: 0, clockin: 1, lexoffice: 0 })
  })

  it("reicht Response UND Bucket in den Error-Interceptor durch", async () => {
    const { client, error } = fakeClient()
    const bucket = fakeBucket()
    instrumentHeyApiClient(client, "clockin", bucket)

    const enriched = await error[0]!(
      { message: "Too Many Attempts." },
      fakeResponse(429, { "retry-after": "4" }, { statusText: "Too Many Requests" }) as never,
      new Request("https://api.example.com/v3/customers"),
      {},
    )

    // Ohne durchgereichten Bucket bliebe das System nach dem 429 offen —
    // die Sperre ist der einzige Schutz für die parallelen Tasks.
    expect(bucket.pauses).toEqual([4_000])
    expect(enriched).toMatchObject({
      message: "Too Many Attempts.",
      status: 429,
      statusText: "Too Many Requests",
      retryAfterMs: 4_000,
    })
    expect(isRateLimited(enriched)).toBe(true)
  })

  it("lässt Netzwerkfehler (ohne Response) auch über den Interceptor unverändert", async () => {
    const { client, error } = fakeClient()
    const bucket = fakeBucket()
    instrumentHeyApiClient(client, "dimacon", bucket)

    const original = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
    const passed = await error[0]!(
      original,
      undefined,
      new Request("https://api.example.com/v3/jobs"),
      {},
    )

    expect(passed).toBe(original)
    expect(bucket.pauses).toEqual([])
  })

  it("registriert die Interceptoren nur einmal je Client", () => {
    const { client, request, error } = fakeClient()
    const bucket = fakeBucket()
    instrumentHeyApiClient(client, "dimacon", bucket)
    instrumentHeyApiClient(client, "dimacon", bucket)
    expect(request).toHaveLength(1)
    expect(error).toHaveLength(1)
  })
})

describe("wrapLexofficeClient", () => {
  it("zählt und drosselt jeden Aufruf, reicht Argumente und Ergebnis durch", async () => {
    const clock = { t: 0 }
    const bucket = createTokenBucket({
      ratePerSec: 2,
      burst: 1,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms
      },
    })
    const inner = {
      get: vi.fn(async () => ({ content: [] })),
      post: vi.fn(async () => ({ id: "neu" })),
      put: vi.fn(async () => ({})),
      del: vi.fn(async () => ({})),
      download: vi.fn(async () => ({ data: Buffer.from(""), fileName: "f", contentType: "t" })),
      upload: vi.fn(async () => ({})),
    }
    const wrapped = wrapLexofficeClient(inner as never, bucket)

    let snapshot: RunMetricsSnapshot | undefined
    await withRunMetrics(
      async () => {
        expect(await wrapped.get("/v1/contacts", { page: "0" })).toEqual({ content: [] })
        expect(await wrapped.post("/v1/contacts", { name: "x" })).toEqual({ id: "neu" })
      },
      (s) => (snapshot = s),
    )

    expect(inner.get).toHaveBeenCalledWith("/v1/contacts", { page: "0" })
    expect(inner.post).toHaveBeenCalledWith("/v1/contacts", { name: "x" })
    expect(snapshot?.requests.lexoffice).toBe(2)
    // Burst 1 bei 2 req/s ⇒ der zweite Aufruf wartet 500 ms.
    expect(clock.t).toBe(500)
  })

  it("läuft außerhalb eines Metrik-Scopes ohne zu werfen", async () => {
    const inner = {
      get: vi.fn(async () => ({ ok: true })),
      post: vi.fn(async () => ({})),
      put: vi.fn(async () => ({})),
      del: vi.fn(async () => ({})),
      download: vi.fn(async () => ({ data: Buffer.from(""), fileName: "f", contentType: "t" })),
      upload: vi.fn(async () => ({})),
    }
    const wrapped = wrapLexofficeClient(inner as never, fakeBucket())
    await expect(wrapped.get("/v1/profile")).resolves.toEqual({ ok: true })
  })
})
