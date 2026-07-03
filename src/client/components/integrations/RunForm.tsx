import { useState } from "react"
import type { ComponentType } from "react"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"

export interface RunFormProps {
  running: boolean
  disabled: boolean
  onRun: (input: unknown) => void
}

/**
 * Run-Form passend zur Integration. Default: Datum + dryRun — passt für
 * alle tagesbasierten Syncs. Integrationen mit anderem Input registrieren
 * hier ihre eigene Form-Komponente (analog zum RunResultView-Dispatch).
 */
const FORMS: Record<string, ComponentType<RunFormProps>> = {
  // "<integration-id>": EigeneRunForm,
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

function DateDryRunForm({ running, disabled, onRun }: RunFormProps) {
  const [date, setDate] = useState<string>(todayISO())
  const [dryRun, setDryRun] = useState<boolean>(true)

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
