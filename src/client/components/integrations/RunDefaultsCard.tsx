import { useState } from "react"
import type { ScheduleEntry } from "#/components/integrations/ScheduleCard"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { Button } from "#/components/ui/button"
import { Label } from "#/components/ui/label"
import { readJson, useApiFetch } from "#/lib/api"
import { describeScope, readScope, RUN_SCOPE_SPECS, toRunDefaults } from "#/lib/run-scope"

/**
 * Umfang-Tab: der persistente Sync-Umfang je (Mandant, Integration). Gilt
 * für ALLE Auslöser — Cron, manueller Lauf und Webhook. Der Modus startet
 * ohne gespeicherten Wert auf „live", weil der Server einen leeren Umfang
 * genau so interpretiert (kein stiller Unterschied zwischen UI und Cron).
 */
export function RunDefaultsCard({
  integrationId,
  runDefaults,
  onSaved,
}: {
  integrationId: string
  /**
   * Der GELADENE Umfang des Mandanten (`{}` = nichts gespeichert). Pflicht:
   * ohne geladenen Wert darf der Editor gar nicht erst rendern — sonst zeigt
   * er die Schema-Defaults als „Gespeicherter Umfang" und überschreibt beim
   * Speichern einen bewusst reduzierten Umfang.
   */
  runDefaults: Record<string, unknown>
  onSaved: (updated: ScheduleEntry) => void
}) {
  const spec = RUN_SCOPE_SPECS[integrationId]
  const [saved, setSaved] = useState<Record<string, unknown>>(runDefaults)
  const initial = readScope(integrationId, saved, { dryRunFallback: false })
  const [dryRun, setDryRun] = useState<boolean>(initial.dryRun)
  const [steps, setSteps] = useState<Record<string, boolean>>(initial.steps)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const apiFetch = useApiFetch()

  if (!spec) {
    return (
      <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">
        diese integration hat keinen einstellbaren umfang
      </p>
    )
  }

  const dirty =
    dryRun !== initial.dryRun ||
    spec.steps.some((s) => Boolean(steps[s.key]) !== initial.steps[s.key])
  const hints = spec.hints(steps)

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const res = await apiFetch(`/api/settings/integrations/${integrationId}/run-defaults`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runDefaults: toRunDefaults({ dryRun, steps }) }),
      })
      const json = await readJson<ScheduleEntry | { error: string }>(res)
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        const updated = json as ScheduleEntry
        const next = updated.runDefaults ?? {}
        setSaved(next)
        const scope = readScope(integrationId, next, { dryRunFallback: false })
        setDryRun(scope.dryRun)
        setSteps(scope.steps)
        setNotice("Gespeichert. Gilt ab sofort für geplante, manuelle und Webhook-Läufe.")
        onSaved(updated)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const fieldId = (suffix: string) => `${integrationId}-scope-${suffix}`

  return (
    <section>
      <dl className="border-rule mb-6 grid grid-cols-2 border md:grid-cols-2">
        <Stat label="Gespeicherter Umfang" value={describeScope(integrationId, saved)} />
        <Stat
          label="Schritte aktiv"
          value={`${spec.steps.filter((s) => steps[s.key]).length} von ${spec.steps.length}`}
        />
      </dl>

      <div className="border-rule space-y-6 border p-6">
        <div>
          <Label htmlFor={fieldId("dry")}>Modus</Label>
          <label
            htmlFor={fieldId("dry")}
            className="border-ink bg-paper text-ink mt-2 flex h-10 w-fit cursor-pointer items-center gap-3 border px-3 text-sm select-none"
          >
            <input
              id={fieldId("dry")}
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              disabled={saving}
              className="accent-mn-accent size-4"
            />
            dauerhaft dry-run (nur loggen)
          </label>
          {dryRun ? (
            <p className="mt-2">
              <MnStatusBadge variant="default">
                dry-run dauerhaft aktiv — es wird nie geschrieben
              </MnStatusBadge>
            </p>
          ) : null}
        </div>

        <div>
          <Label>Schritte</Label>
          <div className="mt-2 flex flex-wrap gap-3">
            {spec.steps.map((step) => (
              <label
                key={step.key}
                htmlFor={fieldId(step.key)}
                className="border-ink bg-paper text-ink flex h-10 cursor-pointer items-center gap-3 border px-3 text-sm select-none"
              >
                <input
                  id={fieldId(step.key)}
                  type="checkbox"
                  checked={Boolean(steps[step.key])}
                  onChange={(e) => setSteps((prev) => ({ ...prev, [step.key]: e.target.checked }))}
                  disabled={saving || (step.requires ? !steps[step.requires] : false)}
                  className="accent-mn-accent size-4"
                />
                {step.label}
              </label>
            ))}
          </div>
          {hints.length > 0 ? (
            <div className="mt-3 max-w-[520px] space-y-1">
              {hints.map((hint) => (
                <p key={hint} className="text-ink-3 font-mono text-[0.7rem] leading-relaxed">
                  {hint}
                </p>
              ))}
            </div>
          ) : null}
        </div>

        <div className="border-rule text-ink-2 border-l-ink border border-l-[3px] px-4 py-3 text-sm">
          <strong className="text-ink mb-1.5 block font-mono text-[0.7rem] font-semibold tracking-[0.18em] uppercase">
            Gilt für alle Auslöser
          </strong>
          Geplante Läufe (Cron) und Webhook-Aufrufe ohne eigenen Body fahren genau diesen Umfang.
          Das manuelle Formular ist damit vorbelegt; dort abweichende Werte gelten nur für den
          einzelnen Lauf. Das Datum wird nie gespeichert — geplante Läufe sind immer „heute".
        </div>

        <div className="flex items-center gap-4 pt-2">
          <Button onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "speichere …" : "Speichern"}
          </Button>
          {dirty ? (
            <span className="text-ink-3 font-mono text-[0.7rem] tracking-[0.18em] uppercase">
              ungespeicherte änderungen
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <MnAlert label="Fehler" className="mt-6">
          {error}
        </MnAlert>
      ) : null}
      {notice && !error ? (
        <div className="border-rule text-ink-2 border-l-ink mt-6 border border-l-[3px] px-4 py-3 text-sm">
          <strong className="text-ink mb-1.5 block font-mono text-[0.7rem] font-semibold tracking-[0.18em] uppercase">
            OK
          </strong>
          {notice}
        </div>
      ) : null}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-rule border-r p-4 last:border-r-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd className="text-ink mt-1 font-mono text-base">{value}</dd>
    </div>
  )
}
