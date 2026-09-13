import type { Client as LexofficeClient } from "@miragon/client-lexoffice"
import { countRequest, type MetricSystem } from "./metrics.js"
import type { TokenBucket } from "./rate-limit.js"

/**
 * Verdrahtet die generierten API-Clients mit Token-Bucket und Lauf-Metrik,
 * ohne die externen npm-Pakete zu ändern:
 *
 * - Request-Interceptor: erst `bucket.acquire()` (proaktives Throttling),
 *   dann `countRequest(system)`. Der Request selbst bleibt UNVERÄNDERT.
 * - Error-Interceptor: hängt `status`/`statusText`/`retryAfterMs`/`url` an
 *   den geworfenen Fehler. Die Clients werfen sonst nur den geparsten
 *   Response-Body — Status und `Retry-After` sind beim Retry längst weg.
 *
 * Bewusst NICHT protokolliert/angehängt: Header, Tokens und Query-Strings.
 * `url` wird auf Origin + Pfad reduziert, damit kein Secret aus einem
 * Query-Parameter in Logs oder Fehlermeldungen landet.
 */

/** Strukturelle Sicht auf die hey-api-Clients (dimacon/clockin). */
export interface InterceptableClient {
  interceptors: {
    request: {
      use(fn: (request: Request, options: unknown) => Request | Promise<Request>): unknown
    }
    error: {
      use(
        fn: (
          error: unknown,
          response: Response | undefined,
          request: Request,
          options: unknown,
        ) => unknown,
      ): unknown
    }
  }
}

/** Nur die Felder, die wir aus der Response lesen (testbar ohne fetch). */
export interface ResponseLike {
  status: number
  statusText?: string
  url?: string
  headers: { get(name: string): string | null }
}

/** Sperre nach einem 429 OHNE Retry-After — kurz, der Retry wartet ohnehin. */
const DEFAULT_PAUSE_MS = 2_000
/** Obergrenze für Retry-After: ein Zielsystem darf uns nicht ewig blockieren. */
const MAX_RETRY_AFTER_MS = 60_000

const instrumented = new WeakSet<object>()

export function instrumentHeyApiClient(
  client: InterceptableClient,
  system: MetricSystem,
  bucket: TokenBucket,
): void {
  // Die Instrumentierung hängt an der GECACHTEN Client-Instanz (clients.ts)
  // und bedient damit je (Mandant, System) genau einen Bucket. Doppelte
  // Registrierung würde jeden Request zweimal zählen.
  if (instrumented.has(client)) return
  instrumented.add(client)

  client.interceptors.request.use(async (request) => {
    await bucket.acquire()
    countRequest(system)
    return request
  })

  client.interceptors.error.use((error, response) =>
    enrichClientError(error, response as ResponseLike | undefined, bucket),
  )
}

/**
 * Reichert den geworfenen Client-Fehler um HTTP-Kontext an. Netzwerkfehler
 * (ohne Response) bleiben unverändert — dort steckt der Grund im `cause`.
 */
export function enrichClientError(
  error: unknown,
  response: ResponseLike | undefined,
  bucket?: TokenBucket,
  nowMs: number = Date.now(),
): unknown {
  if (!response) return error

  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), nowMs)
  if (response.status === 429) bucket?.pauseFor(retryAfterMs ?? DEFAULT_PAUSE_MS)

  const extra: Record<string, unknown> = {
    status: response.status,
    ...(response.statusText ? { statusText: response.statusText } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(response.url ? { url: sanitizeUrl(response.url) } : {}),
  }

  // String-Bodies werden zu einem Objekt gehoben, damit formatError()
  // weiterhin die Meldung sieht und withRetry den Status auswerten kann.
  if (typeof error === "string") return error === "" ? { ...extra } : { message: error, ...extra }
  if (error === null || error === undefined) return { ...extra }
  if (typeof error !== "object") return { message: String(error), ...extra }

  try {
    return Object.assign(error, extra)
  } catch {
    // Eingefrorene Bodies: Kopie statt Absturz.
    return { ...(error as Record<string, unknown>), ...extra }
  }
}

/**
 * `Retry-After` als Sekundenwert ODER HTTP-Datum; ungültig ⇒ undefined.
 *
 * LOAD-BEARING: nicht-positive Werte (`0`, negativ, HTTP-Datum in der
 * Vergangenheit bei Uhr-Drift) liefern ebenfalls `undefined` — NICHT 0.
 * Eine 0 würde beide Bremsen gleichzeitig abschalten: `pauseFor(0)` ist ein
 * No-op (der Bucket bliebe nach dem 429 offen) und `withRetry` nähme die 0
 * als „vom Server genannt" und feuerte alle Versuche ohne Pause in das
 * geschlossene Rate-Limit-Fenster. Ohne verwertbaren Hinweis gelten die
 * Defaults: 2-s-Bucket-Sperre und die 5/10/20/30-s-Treppe.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!value) return undefined
  const raw = value.trim()
  if (raw === "") return undefined

  const seconds = Number(raw)
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return undefined
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000))
  }

  const date = Date.parse(raw)
  if (Number.isNaN(date)) return undefined
  const deltaMs = date - nowMs
  if (deltaMs <= 0) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, deltaMs)
}

/**
 * Lexware Office hat einen handgeschriebenen Client ohne Interceptoren —
 * deshalb ein Wrapper mit identischer Signatur, der je Aufruf drosselt und
 * zählt. Die client-interne 429-Wiederholung läuft am Bucket vorbei
 * (externes Paket) und taucht in den Zählern nicht auf.
 */
export function wrapLexofficeClient(client: LexofficeClient, bucket: TokenBucket): LexofficeClient {
  const gate = async () => {
    await bucket.acquire()
    countRequest("lexoffice")
  }
  return {
    get: async <T>(path: string, params?: Record<string, string>): Promise<T> => {
      await gate()
      return client.get<T>(path, params)
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      await gate()
      return client.post<T>(path, body)
    },
    put: async <T>(path: string, body?: unknown): Promise<T> => {
      await gate()
      return client.put<T>(path, body)
    },
    del: async <T>(path: string): Promise<T> => {
      await gate()
      return client.del<T>(path)
    },
    download: async (path: string) => {
      await gate()
      return client.download(path)
    },
    upload: async <T>(
      path: string,
      fileName: string,
      content: Buffer,
      mimeType?: string,
    ): Promise<T> => {
      await gate()
      return client.upload<T>(path, fileName, content, mimeType)
    },
  }
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    // Kein Query, keine Credentials — nur Origin + Pfad.
    return `${url.origin}${url.pathname}`
  } catch {
    return raw.split("?")[0] ?? raw
  }
}
