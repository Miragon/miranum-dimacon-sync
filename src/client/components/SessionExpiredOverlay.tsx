import { useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { Button } from "#/components/ui/button"

/**
 * Nicht-destruktiver Ersatz für den früheren Sofort-Redirect: das Overlay
 * legt sich ÜBER die laufende App, unmountet aber nichts — offene
 * Formulareingaben (Zugangsdaten, Feld-Zuordnung) bleiben im React-State
 * und sind hinter dem halbtransparenten Hintergrund weiter sichtbar.
 *
 * LOAD-BEARING: „Erneut versuchen" ist der Rückweg IN der Seite. Das Overlay
 * öffnet sich auch bei einem transienten WorkOS-Fehler (429/5xx beim
 * Hintergrund-Refresh, `onRefreshFailure`) — dann ist die Session real noch
 * gültig (der Refresh hängt in Produktion am WorkOS-Cookie) und ein
 * erzwungener Refresh heilt sie. Ohne diese Aktion bliebe nur „Neu anmelden"
 * = voller PKCE-Redirect, der ausgerechnet die Eingaben verwirft, die dieses
 * Overlay schützen soll.
 */
export function SessionExpiredOverlay({
  onRetry,
  onSignIn,
  error,
}: {
  /** Stiller Force-Refresh. `true` = Session wieder gültig, Overlay schließt sich. */
  onRetry: () => Promise<boolean>
  onSignIn: () => void
  error?: string | null
}) {
  const [pending, setPending] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)

  const retry = () => {
    setPending(true)
    setRetryFailed(false)
    void onRetry()
      .then((ok) => {
        // Bei Erfolg unmountet der Aufrufer dieses Overlay — kein State-Update nötig.
        if (!ok) setRetryFailed(true)
      })
      .catch(() => setRetryFailed(true))
      .finally(() => setPending(false))
  }

  return (
    <div className="bg-ink/20 fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="border-rule bg-paper w-full max-w-md space-y-4 border p-6">
        {/* NICHT „Sitzung abgelaufen": das Overlay öffnet auch bei einem
            transienten Fehler des Refresh-Endpunkts, während die Sitzung
            weiterläuft. Der Titel behauptete dann etwas, das nachweislich
            falsch war — und schickte in die Neuanmeldung statt in den Retry. */}
        <MnAlert label="Anmeldung nicht erneuert">
          Der Anmeldedienst konnte die Sitzung gerade nicht erneuern. Ihre Eingaben bleiben erhalten
          — versuchen Sie es erneut oder melden Sie sich neu an.
          {retryFailed ? (
            <span className="text-ink-2 mt-3 block text-sm">
              Erneuern fehlgeschlagen — bitte neu anmelden.
            </span>
          ) : null}
          {error ? <span className="text-ink-2 mt-3 block text-sm">{error}</span> : null}
        </MnAlert>
        <div className="flex flex-wrap gap-2">
          <Button onClick={retry} disabled={pending}>
            {pending ? "wird erneuert …" : "Erneut versuchen"}
          </Button>
          <Button variant="secondary" onClick={onSignIn}>
            Neu anmelden
          </Button>
        </div>
      </div>
    </div>
  )
}
