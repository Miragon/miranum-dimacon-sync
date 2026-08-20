import type { Context } from "hono"
import { CredentialsMissingError } from "../lib/clients.js"
import { CredentialCryptoError } from "../lib/crypto.js"
import { log } from "../lib/log.js"

/**
 * Gemeinsame Fehlerzuordnung der Probe-Routen (/api/{dimacon,clockin,
 * lexoffice} — manuelle Verifikations-Endpoints gegen die GESPEICHERTEN
 * Zugangsdaten; das „Verbindung testen" der UI läuft über
 * POST /api/credentials/:system/test) sowie des Test-Endpoints selbst.
 * Fehlende Credentials sind ein erwartbarer 503; Decrypt-Fehler bleiben ein
 * eigener 500 (nie als „nicht hinterlegt" maskieren). Alles andere
 * (Upstream-Fehler) fällt zum onError-Handler durch.
 */
export function probeErrorResponse(c: Context, err: unknown): Response | undefined {
  if (err instanceof CredentialsMissingError) {
    return c.json(
      { error: `Zugangsdaten für "${err.system}" sind nicht hinterlegt`, code: err.code },
      503,
    )
  }
  if (err instanceof CredentialCryptoError) {
    log.error("credential decryption failed", { kind: err.kind, keyId: err.keyId })
    return c.json(
      {
        error:
          "Zugangsdaten können nicht entschlüsselt werden (Schlüssel wurde gewechselt?) — " +
          "Token in den Einstellungen neu speichern behebt das",
      },
      500,
    )
  }
  return undefined
}
