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
  // Tages-Sync mit zuschaltbaren Schritten
  "dimacon-clockin": DimaconClockinRunForm,
  // Kompletter Kundenbestand mit zuschaltbaren Schritten — kein Datums-Input
  "dimacon-lexoffice": DimaconLexofficeRunForm,
  // Kompletter Mitarbeiterbestand beider Systeme — kein Datums-Input
  "dimacon-clockin-employees": (props) => (
    <DryRunOnlyForm
      {...props}
      hint="Gleicht alle Mitarbeiter in beide Richtungen ab — ein Live-Lauf legt fehlende Mitarbeiter in Clockin und Dimacon an."
    />
  ),
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

function DryRunOnlyForm({ running, disabled, onRun, hint }: RunFormProps & { hint: string }) {
  const [dryRun, setDryRun] = useState<boolean>(true)

  return (
    <div className="border-rule flex flex-wrap items-end gap-6 border p-6">
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
      <p className="text-ink-3 max-w-[360px] font-mono text-[0.7rem] leading-relaxed">{hint}</p>
      <div className="ml-auto">
        <Button
          onClick={() => onRun({ dryRun })}
          disabled={running || disabled}
          variant={dryRun ? "default" : "accent"}
        >
          {running ? "läuft …" : dryRun ? "Dry-Run starten" : "Run starten"}
        </Button>
      </div>
    </div>
  )
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

function DimaconClockinRunForm({ running, disabled, onRun }: RunFormProps) {
  const [date, setDate] = useState<string>(todayISO())
  const [dryRun, setDryRun] = useState<boolean>(true)
  const [customers, setCustomers] = useState<boolean>(true)
  const [employees, setEmployees] = useState<boolean>(true)
  const [projects, setProjects] = useState<boolean>(true)
  const [archive, setArchive] = useState<boolean>(true)

  const hint = !projects
    ? "Es werden keine Projekte angelegt oder aktualisiert — nur Zuordnung/Archivierung."
    : !customers
      ? "Neue Projekte ohne vorhandenen Clockin-Kunden werden übersprungen."
      : null

  return (
    <div className="border-rule space-y-6 border p-6">
      <div className="flex flex-wrap items-end gap-6">
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
          <Label>Modus</Label>
          <div className="mt-2">
            <CheckBox
              id="run-dry"
              label="dry-run (nur loggen)"
              checked={dryRun}
              onChange={setDryRun}
              disabled={running}
            />
          </div>
        </div>
        <div className="ml-auto">
          <Button
            onClick={() =>
              onRun({ date, dryRun, steps: { customers, employees, projects, archive } })
            }
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
          <CheckBox
            id="step-customers"
            label="Kunden anlegen"
            checked={customers}
            onChange={setCustomers}
            disabled={running}
          />
          <CheckBox
            id="step-projects"
            label="Projekte anlegen/aktualisieren"
            checked={projects}
            onChange={setProjects}
            disabled={running}
          />
          <CheckBox
            id="step-employees"
            label="Mitarbeiter-Zuordnung"
            checked={employees}
            onChange={setEmployees}
            disabled={running}
          />
          <CheckBox
            id="step-archive"
            label="Archivierung"
            checked={archive}
            onChange={setArchive}
            disabled={running}
          />
        </div>
        {hint ? (
          <p className="text-ink-3 mt-3 max-w-[520px] font-mono text-[0.7rem] leading-relaxed">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function DimaconLexofficeRunForm({ running, disabled, onRun }: RunFormProps) {
  const [dryRun, setDryRun] = useState<boolean>(true)
  const [createContacts, setCreateContacts] = useState<boolean>(true)
  const [alignNumbers, setAlignNumbers] = useState<boolean>(true)

  const hint = !createContacts
    ? "Nur Abgleich — es werden keine Lexware-Kontakte angelegt."
    : "Läuft über den gesamten Dimacon-Kundenbestand — ein Live-Lauf legt fehlende Lexware-Kontakte an."

  return (
    <div className="border-rule space-y-6 border p-6">
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <Label>Modus</Label>
          <div className="mt-2">
            <CheckBox
              id="lex-dry"
              label="dry-run (nur loggen)"
              checked={dryRun}
              onChange={setDryRun}
              disabled={running}
            />
          </div>
        </div>
        <div className="ml-auto">
          <Button
            onClick={() => onRun({ dryRun, steps: { createContacts, alignNumbers } })}
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
          <CheckBox
            id="lex-step-contacts"
            label="Lexware-Kontakte anlegen"
            checked={createContacts}
            onChange={setCreateContacts}
            disabled={running}
          />
          <CheckBox
            id="lex-step-align"
            label="Kundennummern angleichen"
            checked={alignNumbers}
            onChange={setAlignNumbers}
            disabled={running}
          />
        </div>
        <p className="text-ink-3 mt-3 max-w-[520px] font-mono text-[0.7rem] leading-relaxed">
          {hint}
        </p>
      </div>
    </div>
  )
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
