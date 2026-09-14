import { useState, type ReactNode } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { Button } from "#/components/ui/button"
import type { SessionExpiredReason } from "#/lib/api"

/**
 * Was das Overlay sagt, hängt am Grund — die beiden Fälle haben für den Nutzer
 * nichts miteinander zu tun.
 *
 * LOAD-BEARING (live gemessen): Im 401-Dauerfall gelingt der Force-Refresh
 * gegen WorkOS jedes Mal, nur unser Backend weist das frische Token ab. Ein
 * Overlay, das dann „Der Anmeldedienst konnte die Sitzung nicht erneuern"
 * behauptet, beschreibt genau das Gegenteil dessen, was passiert ist, und
 * schickt den Betreiber zur falschen Ursache.
 */
const TEXTS: Record<SessionExpiredReason, { label: string; body: ReactNode }> = {
  "refresh-failed": {
    label: "Anmeldung nicht erneuert",
    body: (
      <>
        Der Anmeldedienst konnte die Sitzung gerade nicht erneuern. „Erneut versuchen" setzt genau
        hier fort und behält, was Sie gerade offen haben; „Neu anmelden" lädt die Anwendung neu.
      </>
    ),
  },
  "server-rejected": {
    label: "Zugriff abgelehnt",
    body: (
      <>
        Die Anmeldung wurde soeben erneuert, der Server weist sie trotzdem zurück. Die Ursache liegt
        dann nicht bei Ihrer Sitzung, sondern beim Server — eine Neuanmeldung ändert daran in der
        Regel nichts. „Erneut versuchen" prüft es erneut und behält, was Sie gerade offen haben;
        hält der Zustand an, wenden Sie sich an den Betrieb.
      </>
    ),
  },
}

/**
 * Nicht-destruktiver Ersatz für den früheren Sofort-Redirect: das Overlay
 * legt sich ÜBER die laufende App, unmountet aber nichts — offene
 * Formulareingaben (Zugangsdaten, Feld-Zuordnung) bleiben im React-State
 * und sind hinter dem halbtransparenten Hintergrund weiter sichtbar.
 *
 * Der Hinweistext knüpft die Zusage bewusst an die AKTION und behauptet
 * nichts über den Inhalt dahinter: Tritt der Ablauf auf einem Screen mit
 * offenem Formular auf, bleibt dieses erhalten — tritt er bei dauerhaften
 * 401 auf, steht hinter dem Overlay nur der Ladezustand des TenantGate. Ein
 * pauschales „Ihre Eingaben bleiben erhalten" war dort nachweislich falsch.
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
  reason,
  onRetry,
  onSignIn,
  error,
}: {
  /** Warum der Zugang weg ist — bestimmt Titel und Text (s. `TEXTS`). */
  reason: SessionExpiredReason
  /** Stiller Force-Refresh. `true` = Session wieder gültig, Overlay schließt sich. */
  onRetry: () => Promise<boolean>
  onSignIn: () => void
  error?: string | null
}) {
  const [pending, setPending] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  const text = TEXTS[reason]

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
        <MnAlert label={text.label}>
          {text.body}
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
