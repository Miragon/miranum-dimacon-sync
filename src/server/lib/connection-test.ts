import { createClockInClient, sdk as clockinSdk } from "@miragon/client-clockin"
import { createDimaconClient, sdk as dimaconSdk } from "@miragon/client-dimacon"
import { createLexofficeClient } from "@miragon/client-lexoffice"
import { createSevdeskClient } from "@miragon/client-sevdesk"
import {
  ClockinCredentialsSchema,
  DimaconCredentialsSchema,
  LexofficeCredentialsSchema,
  SevdeskCredentialsSchema,
} from "../db/repos/credentials.js"
import type { CredentialSystem } from "../db/repos/credentials.js"
import { formatError } from "./errors.js"

const TIMEOUT_MS = 10_000
const TIMEOUT_MESSAGE = `Zeitüberschreitung nach ${TIMEOUT_MS / 1000} Sekunden — ist die Base-URL korrekt und erreichbar?`

/**
 * Verbindungstest mit beliebigen (auch UNGESPEICHERTEN) Zugangsdaten: baut
 * einen Wegwerf-Client — bewusst OHNE getClientsForTenant, damit weder Cache
 * noch DB berührt werden — und macht denselben billigen Identitäts-Call wie
 * die Probe-Routen. Auflösung (Erfolg/Fehlermeldung) macht der Aufrufer über
 * resolve/reject; Upstream-Fehler kommen dank mapUpstreamError mit
 * HTTP-Status statt als roher Fehler-Body an.
 */
export async function testConnection(
  system: CredentialSystem,
  payload: Record<string, string>,
): Promise<void> {
  try {
    switch (system) {
      case "dimacon": {
        const creds = DimaconCredentialsSchema.parse(payload)
        const client = createDimaconClient(creds)
        client.interceptors.error.use(mapUpstreamError)
        await dimaconSdk.getCurrentUser({ client, signal: AbortSignal.timeout(TIMEOUT_MS) })
        return
      }
      case "clockin": {
        const creds = ClockinCredentialsSchema.parse(payload)
        const client = createClockInClient(creds)
        client.interceptors.error.use(mapUpstreamError)
        await clockinSdk.getAListOfProjects({ client, signal: AbortSignal.timeout(TIMEOUT_MS) })
        return
      }
      case "lexoffice": {
        const creds = LexofficeCredentialsSchema.parse(payload)
        await raceTimeout(createLexofficeClient(creds).get("/v1/profile"))
        return
      }
      case "sevdesk": {
        const creds = SevdeskCredentialsSchema.parse(payload)
        // Billigster authentifizierter Call; wie Lexware ohne AbortSignal.
        await raceTimeout(createSevdeskClient(creds).get("/Contact", { limit: "1" }))
        return
      }
    }
  } catch (err) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(TIMEOUT_MESSAGE)
    }
    throw err
  }
}

/**
 * hey-api wirft bei non-2xx den geparsten Fehler-Body ("finalError || {}") —
 * ohne Status wäre der häufigste Fall (falsches Token → 401 ohne Body) die
 * nichtssagende Meldung "{}". Netzwerkfehler (response undefined) bleiben
 * unangetastet, formatError liest dort die undici-cause-Kette.
 */
export function mapUpstreamError(error: unknown, response: Response | undefined): unknown {
  if (!response) return error
  const detail = formatError(error)
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
  const noise = detail.length === 0 || detail === "{}" || detail === "unknown error"
  return new Error(noise ? status : `${status} — ${detail}`)
}

/**
 * Der Lexoffice-Client akzeptiert kein AbortSignal — der Verlierer-Fetch
 * läuft ins Leere (read-only GET, folgenlos); das catch verhindert eine
 * unhandled rejection, wenn er später doch noch fehlschlägt.
 */
async function raceTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
    promise.catch(() => undefined)
  }
}
