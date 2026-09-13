import { Button } from "#/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog"
import type { RunScopeSpec } from "#/lib/run-scope"

/**
 * Rückfrage vor einem LIVE-Lauf. Bewusst nur dort: ein dry-run schreibt
 * nichts, und eine Rückfrage, die bei jeder harmlosen Aktion aufpoppt, wird
 * binnen einer Woche weggeklickt, ohne gelesen zu werden.
 *
 * Gezeigt wird, was der Lauf ANFASST — nicht die Liste aller Schritte. Der
 * Nutzer sieht im Formular bereits, was angehakt ist; was er dort NICHT
 * sieht, ist die Konsequenz: welche Fremdsysteme beschrieben werden und
 * welche Schritte davon löschend bzw. archivierend wirken.
 */
export function LiveRunDialog({
  open,
  onOpenChange,
  onConfirm,
  integrationName,
  systems,
  spec,
  steps,
  date,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  integrationName: string
  systems: string[]
  spec?: RunScopeSpec
  steps: Record<string, boolean>
  date?: string
}) {
  const active = (spec?.steps ?? []).filter((step) => steps[step.key])
  // Schritte, die über das Anlegen hinausgehen — die sind der Grund für die
  // Rückfrage. Die Schlüssel stehen in RUN_SCOPE_SPECS (Client) und im
  // inputSchema der Integration (Server).
  const heavy = active.filter((step) => step.key === "archive" || !step.default)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-h-4">Live-Lauf starten?</DialogTitle>
          <DialogDescription className="text-ink-2 mt-2 text-sm leading-relaxed">
            <strong className="text-ink">{integrationName}</strong> schreibt in diesem Modus direkt
            nach <span className="font-mono">{systems.join(", ")}</span>
            {date ? (
              <>
                {" "}
                für den <span className="font-mono">{date}</span>
              </>
            ) : null}
            . Ein dry-run würde stattdessen nur protokollieren.
          </DialogDescription>
        </DialogHeader>

        <dl className="border-rule space-y-2 border-t pt-4 text-sm">
          <div className="flex gap-3">
            <dt className="text-ink-3 w-28 shrink-0 font-mono text-[0.7rem] tracking-[0.14em] uppercase">
              Schritte
            </dt>
            <dd className="text-ink">
              {active.length > 0 ? active.map((s) => s.label).join(", ") : "keine"}
            </dd>
          </div>
          {heavy.length > 0 ? (
            <div className="flex gap-3">
              <dt className="text-mn-accent w-28 shrink-0 font-mono text-[0.7rem] tracking-[0.14em] uppercase">
                Achtung
              </dt>
              <dd className="text-ink">
                {heavy.map((s) => s.label).join(", ")} — diese Schritte verändern Bestandsdaten und
                sind nur von Hand zurückzunehmen.
              </dd>
            </div>
          ) : null}
        </dl>

        <DialogFooter>
          <DialogClose render={<Button variant="secondary">Abbrechen</Button>} />
          <Button variant="accent" onClick={onConfirm}>
            Live-Lauf starten
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
