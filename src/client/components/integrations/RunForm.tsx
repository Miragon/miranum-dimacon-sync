import { Link } from "@tanstack/react-router"
import { useState } from "react"
import type { ComponentType } from "react"
import { StepNotes } from "#/components/integrations/bits"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { readScope, RUN_SCOPE_SPECS } from "#/lib/run-scope"

export interface RunFormProps {
  running: boolean
  disabled: boolean
  onRun: (input: unknown) => void
  /** Gespeicherter Umfang des Mandanten — belegt Modus + Schritte vor. */
  defaults?: Record<string, unknown>
}

/**
 * Run-Form passend zur Integration. Default: Datum + dryRun — passt für
 * alle tagesbasierten Syncs. Integrationen mit anderem Input registrieren
 * hier ihre eigene Form-Komponente (analog zum RunResultView-Dispatch).
 */
const FORMS: Record<string, ComponentType<RunFormProps>> = {
  // Tages-Sync mit zuschaltbaren Schritten
  "dimacon-clockin": DimaconClockinRunForm,
  // Kompletter Kundenbestand mit zuschaltbaren Schritten — kein Datums-Input
  "dimacon-lexoffice": DimaconLexofficeRunForm,
}

export function RunForm({ integrationId, ...props }: RunFormProps & { integrationId: string }) {
  const Custom = FORMS[integrationId]
  if (Custom) return <Custom {...props} />
  return <DateDryRunForm {...props} />
}

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function CheckBox({
  id,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled: boolean
}) {
  return (
    <label
      htmlFor={id}
      className="border-ink bg-paper text-ink flex h-10 cursor-pointer items-center gap-3 border px-3 text-sm select-none"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="accent-mn-accent size-4"
      />
      {label}
    </label>
  )
}

function DimaconClockinRunForm(props: RunFormProps) {
  return <ScopeRunForm {...props} integrationId="dimacon-clockin" withDate />
}

function DimaconLexofficeRunForm(props: RunFormProps) {
  return <ScopeRunForm {...props} integrationId="dimacon-lexoffice" />
}

/**
 * Formular für alle Integrationen mit konfigurierbarem Umfang
 * (RUN_SCOPE_SPECS): Modus + Schritte kommen aus dem gespeicherten Umfang,
 * Abweichungen gelten nur für diesen Lauf. Das Datum wird NIE vorbelegt —
 * ein manueller Lauf ist immer „heute", solange nichts anderes gewählt ist.
 */
function ScopeRunForm({
  integrationId,
  withDate,
  running,
  disabled,
  onRun,
  defaults,
}: RunFormProps & { integrationId: string; withDate?: boolean }) {
  const spec = RUN_SCOPE_SPECS[integrationId]
  // Lazy: der gespeicherte Umfang ist die Startbelegung, danach gehört der
  // Zustand dem Formular (Abweichungen gelten nur für diesen Lauf).
  const [initial] = useState(() => readScope(integrationId, defaults, { dryRunFallback: true }))
  const [date, setDate] = useState<string>(todayISO())
  const [dryRun, setDryRun] = useState<boolean>(initial.dryRun)
  const [steps, setSteps] = useState<Record<string, boolean>>(initial.steps)

  const hints = spec.hints(steps)

  return (
    <div className="border-rule space-y-6 border p-6">
      <div className="flex flex-wrap items-end gap-6">
        {withDate ? (
          <div className="w-[180px]">
            <Label htmlFor="run-date">Datum</Label>
            <Input
              id="run-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-2"
              disabled={running}
            />
          </div>
        ) : null}
        <div>
          <Label>Modus</Label>
          <div className="mt-2">
            <CheckBox
              id={`${integrationId}-dry`}
              label="dry-run (nur loggen)"
              checked={dryRun}
              onChange={setDryRun}
              disabled={running}
            />
          </div>
        </div>
        <div className="ml-auto">
          <Button
            onClick={() => onRun({ ...(withDate ? { date } : {}), dryRun, steps })}
            disabled={running || disabled}
            variant={dryRun ? "default" : "accent"}
          >
            {running ? "läuft …" : dryRun ? "Dry-Run starten" : "Run starten"}
          </Button>
        </div>
      </div>
      <div>
        <Label>Schritte</Label>
        <div className="mt-2 flex flex-wrap gap-3">
          {spec.steps.map((step) => (
            <CheckBox
              key={step.key}
              id={`${integrationId}-step-${step.key}`}
              label={step.label}
              checked={Boolean(steps[step.key])}
              onChange={(v) => setSteps((prev) => ({ ...prev, [step.key]: v }))}
              disabled={running || (step.requires ? !steps[step.requires] : false)}
            />
          ))}
        </div>
        <StepNotes steps={spec.steps} />
        {hints.length > 0 ? (
          <div className="mt-3 max-w-[520px] space-y-1">
            {hints.map((hint) => (
              <p key={hint} className="text-ink-3 font-mono text-[0.7rem] leading-relaxed">
                {hint}
              </p>
            ))}
          </div>
        ) : null}
        <p className="text-ink-3 mt-3 font-mono text-[0.7rem] leading-relaxed">
          Vorbelegt aus dem gespeicherten Umfang — Abweichungen gelten nur für diesen Lauf.{" "}
          <Link
            to="/sync/$integrationId/settings"
            params={{ integrationId }}
            search={{ tab: "umfang" }}
            className="text-ink-2 hover:text-ink underline underline-offset-4"
          >
            umfang dauerhaft ändern →
          </Link>
        </p>
      </div>
    </div>
  )
}

function DateDryRunForm({ running, disabled, onRun, defaults }: RunFormProps) {
  const [date, setDate] = useState<string>(todayISO())
  const [dryRun, setDryRun] = useState<boolean>(
    typeof defaults?.dryRun === "boolean" ? defaults.dryRun : true,
  )

  return (
    <div className="border-rule flex flex-wrap items-end gap-6 border p-6">
      <div className="w-[180px]">
        <Label htmlFor="run-date">Datum</Label>
        <Input
          id="run-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-2"
          disabled={running}
        />
      </div>
      <div>
        <Label htmlFor="run-dry">Modus</Label>
        <label
          htmlFor="run-dry"
          className="border-ink bg-paper text-ink mt-2 flex h-10 cursor-pointer items-center gap-3 border px-3 text-sm select-none"
        >
          <input
            id="run-dry"
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            disabled={running}
            className="accent-mn-accent size-4"
          />
          dry-run (nur loggen)
        </label>
      </div>
      <div className="ml-auto">
        <Button
          onClick={() => onRun({ date, dryRun })}
          disabled={running || disabled}
          variant={dryRun ? "default" : "accent"}
        >
          {running ? "läuft …" : dryRun ? "Dry-Run starten" : "Run starten"}
        </Button>
      </div>
    </div>
  )
}
