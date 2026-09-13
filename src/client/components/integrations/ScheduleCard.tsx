import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { readJson, useApiFetch } from "#/lib/api"
import { formatRunDate } from "#/lib/integrations"
import { describeScope, RUN_SCOPE_SPECS } from "#/lib/run-scope"
import {
  ALL_DAYS,
  cronToSpec,
  DAY_LABELS,
  describeSpec,
  INTERVAL_HOURS,
  INTERVAL_MINUTES,
  specToCron,
  type ScheduleSpec,
} from "#/lib/schedule-cron"

export interface ScheduleEntry {
  id: string
  name: string
  enabled: boolean
  cron?: string
  timezone: string
  active: boolean
  nextRun: string | null
  nextRuns: string[]
  /**
   * Gespeicherter Run-Umfang — der Cron fährt genau diesen. NICHT optional:
   * `/api/settings/integrations` liefert das Feld immer (mindestens `{}`).
   * Damit ist „nicht geladen" typseitig kein `undefined`, das im Editor
   * stillschweigend als „Schema-Defaults" durchginge.
   */
  runDefaults: Record<string, unknown>
}

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "Täglich 06:00", expr: "0 6 * * *" },
  { label: "Werktags 06:00", expr: "0 6 * * 1-5" },
  { label: "Stündlich", expr: "0 * * * *" },
  { label: "Alle 15 min", expr: "*/15 * * * *" },
]

type Mode = ScheduleSpec["mode"]

const MODE_LABELS: Record<Mode, string> = {
  daily: "Täglich",
  interval: "Intervall",
  expert: "Experte",
}

// Auswahl-Optionen des Intervall-Dropdowns — Wert kodiert Einheit + Anzahl.
const INTERVAL_OPTIONS: {
  value: string
  label: string
  unit: "minutes" | "hours"
  every: number
}[] = [
  ...INTERVAL_MINUTES.map((n) => ({
    value: `m${n}`,
    label: `Alle ${n} Minuten`,
    unit: "minutes" as const,
    every: n,
  })),
  ...INTERVAL_HOURS.map((n) => ({
    value: `h${n}`,
    label: n === 1 ? "Stündlich" : `Alle ${n} Stunden`,
    unit: "hours" as const,
    every: n,
  })),
]

const selectClass =
  "border-ink bg-paper text-ink h-10 border px-3 font-mono text-sm focus-visible:outline-none"

export function ScheduleCard({
  entry,
  onSaved,
}: {
  entry: ScheduleEntry
  onSaved: (updated: ScheduleEntry) => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(entry.enabled)
  const [timezone, setTimezone] = useState(entry.timezone)
  // Gespeicherter Cron → Picker-Zustand; nicht abbildbare Muster öffnen
  // automatisch im Experten-Modus (cronToSpec).
  const [spec, setSpec] = useState<ScheduleSpec>(() => cronToSpec(entry.cron))
  const apiFetch = useApiFetch()

  const cron = specToCron(spec)
  // Experte darf leer sein (= kein Cron); die Picker erzeugen immer einen.
  const cronOrUndefined = cron.trim().length > 0 ? cron.trim() : undefined

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const body = {
        enabled,
        cron: cronOrUndefined,
        timezone: timezone.trim(),
      }
      const res = await apiFetch(`/api/settings/integrations/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await readJson<ScheduleEntry | { error: string }>(res)
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        const updated = json as ScheduleEntry
        setEnabled(updated.enabled)
        setTimezone(updated.timezone)
        setSpec(cronToSpec(updated.cron))
        setNotice("Gespeichert. Scheduler neu gestartet.")
        onSaved(updated)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Normalisiert vergleichen: ein gespeicherter Cron "0 6 * * 1,2,3,4,5"
  // und die Picker-Form "0 6 * * 1-5" sind derselbe Zeitplan; und ohne
  // gespeicherten Cron ist die Default-Picker-Auswahl nicht "dirty".
  const initialCron = specToCron(cronToSpec(entry.cron))
  const dirty =
    enabled !== entry.enabled || cron.trim() !== initialCron || timezone.trim() !== entry.timezone

  function switchMode(mode: Mode) {
    if (mode === spec.mode) return
    if (mode === "expert") {
      // Aktuelle Picker-Auswahl als Startpunkt ins Roh-Feld übernehmen.
      setSpec({ mode: "expert", cron })
    } else if (mode === "daily") {
      setSpec({ mode: "daily", hour: 6, minute: 0, days: ALL_DAYS })
    } else {
      setSpec({ mode: "interval", unit: "minutes", every: 15 })
    }
  }

  function toggleDay(day: number) {
    if (spec.mode !== "daily") return
    const has = spec.days.includes(day)
    // Mindestens ein Tag bleibt aktiv — sonst gäbe es keinen gültigen Cron.
    if (has && spec.days.length === 1) return
    setSpec({
      ...spec,
      days: has ? spec.days.filter((d) => d !== day) : [...spec.days, day],
    })
  }

  const fieldId = (suffix: string) => `${entry.id}-${suffix}`
  // Nur Integrationen mit konfigurierbarem Umfang bekommen den Verweis.
  const hasScope = entry.id in RUN_SCOPE_SPECS
  const intervalValue =
    spec.mode === "interval" ? `${spec.unit === "minutes" ? "m" : "h"}${spec.every}` : "m15"

  return (
    <section>
      <dl className="border-rule mb-6 grid grid-cols-2 border md:grid-cols-5">
        <Stat label="Cron aktiv" value={entry.active ? "ja" : "nein"} />
        <Stat label="Zeitplan" value={entry.cron ? describeSpec(cronToSpec(entry.cron)) : "—"} />
        <Stat label="Zeitzone" value={entry.timezone} />
        <Stat
          label="Nächster Lauf"
          value={entry.nextRun ? formatRunDate(entry.nextRun, entry.timezone) : "—"}
        />
        {/* Macht einen dauerhaft eingeschränkten oder auf dry-run gestellten
            Cron schon im Zeitplan-Tab sichtbar. */}
        <Stat label="Umfang" value={describeScope(entry.id, entry.runDefaults)} />
      </dl>

      {hasScope ? (
        <p className="text-ink-3 mb-6 font-mono text-[0.7rem]">
          Der geplante Lauf fährt den gespeicherten Umfang —{" "}
          <Link
            to="/sync/$integrationId/settings"
            params={{ integrationId: entry.id }}
            search={{ tab: "umfang" }}
            className="text-ink-2 hover:text-ink underline underline-offset-4"
          >
            umfang ändern →
          </Link>
        </p>
      ) : null}

      <div className="border-rule space-y-6 border p-6">
        <div>
          <Label htmlFor={fieldId("enabled")}>Automatischer Lauf</Label>
          <label
            htmlFor={fieldId("enabled")}
            className="border-ink bg-paper text-ink mt-2 flex h-10 cursor-pointer items-center gap-3 border px-3 text-sm select-none"
          >
            <input
              id={fieldId("enabled")}
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={saving}
              className="accent-mn-accent size-4"
            />
            Scheduler aktivieren
          </label>
        </div>

        <div>
          <Label>Wiederholung</Label>
          <div className="mt-2 flex flex-wrap gap-3">
            {(Object.keys(MODE_LABELS) as Mode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => switchMode(mode)}
                disabled={saving}
                className={`border px-3 py-1.5 font-mono text-[0.7rem] tracking-[0.14em] uppercase transition-colors ${
                  spec.mode === mode
                    ? "border-ink text-ink"
                    : "border-rule text-ink-2 hover:border-ink hover:text-ink"
                }`}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>

        {spec.mode === "daily" ? (
          <>
            <div>
              <Label htmlFor={fieldId("hour")}>Uhrzeit</Label>
              <div className="mt-2 flex items-center gap-2">
                <select
                  id={fieldId("hour")}
                  value={spec.hour}
                  onChange={(e) => setSpec({ ...spec, hour: Number(e.target.value) })}
                  disabled={saving}
                  className={selectClass}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}
                    </option>
                  ))}
                </select>
                <span className="text-ink font-mono text-sm">:</span>
                <select
                  aria-label="Minute"
                  value={spec.minute}
                  onChange={(e) => setSpec({ ...spec, minute: Number(e.target.value) })}
                  disabled={saving}
                  className={selectClass}
                >
                  {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, "0")}
                    </option>
                  ))}
                </select>
                <span className="text-ink-3 font-mono text-[0.7rem]">Uhr</span>
              </div>
            </div>

            <div>
              <Label>Wochentage</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {ALL_DAYS.map((day) => {
                  const active = spec.days.includes(day)
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleDay(day)}
                      disabled={saving}
                      aria-pressed={active}
                      className={`border px-3 py-1.5 font-mono text-[0.7rem] tracking-[0.14em] uppercase transition-colors ${
                        active
                          ? "border-ink bg-ink text-paper"
                          : "border-rule text-ink-2 hover:border-ink hover:text-ink"
                      }`}
                    >
                      {DAY_LABELS[day]}
                    </button>
                  )
                })}
              </div>
              <p className="text-ink-3 mt-2 font-mono text-[0.7rem]">
                Alle Tage aktiv = täglich. Mindestens ein Tag bleibt ausgewählt.
              </p>
            </div>
          </>
        ) : null}

        {spec.mode === "interval" ? (
          <div>
            <Label htmlFor={fieldId("interval")}>Rhythmus</Label>
            <select
              id={fieldId("interval")}
              value={intervalValue}
              onChange={(e) => {
                const opt = INTERVAL_OPTIONS.find((o) => o.value === e.target.value)
                if (opt) setSpec({ mode: "interval", unit: opt.unit, every: opt.every })
              }}
              disabled={saving}
              className={`${selectClass} mt-2 block`}
            >
              {INTERVAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {spec.mode === "expert" ? (
          <div>
            <Label htmlFor={fieldId("cron")}>Cron-Ausdruck</Label>
            <Input
              id={fieldId("cron")}
              type="text"
              value={spec.cron}
              onChange={(e) => setSpec({ mode: "expert", cron: e.target.value })}
              placeholder="0 6 * * *"
              className="mt-2 font-mono"
              disabled={saving}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.expr}
                  type="button"
                  onClick={() => setSpec({ mode: "expert", cron: p.expr })}
                  disabled={saving}
                  className="border-rule text-ink-2 hover:border-ink hover:text-ink border px-2 py-1 font-mono text-[0.7rem] tracking-[0.05em] transition-colors"
                >
                  {p.label} · {p.expr}
                </button>
              ))}
            </div>
            <p className="text-ink-3 mt-2 font-mono text-[0.7rem]">
              Standard 5-Felder cron: Minute · Stunde · Tag · Monat · Wochentag.
            </p>
          </div>
        ) : null}

        {spec.mode !== "expert" ? (
          <p className="text-ink-3 font-mono text-[0.7rem]">
            {describeSpec(spec)} · <span className="text-ink-2">cron {cron}</span>
          </p>
        ) : null}

        <div className="w-[260px]">
          <Label htmlFor={fieldId("tz")}>Zeitzone</Label>
          <Input
            id={fieldId("tz")}
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Europe/Berlin"
            className="mt-2 font-mono"
            disabled={saving}
          />
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

      {entry.active && entry.nextRuns.length > 0 ? (
        // Nur wenn der Cron-Slot wirklich läuft — bei deaktiviertem Scheduler
        // wäre eine "Nächste Läufe"-Liste irreführend (es läuft ja nichts).
        <div className="mt-6">
          <h3 className="text-ink-3 mb-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">
            Nächste 5 Läufe (gespeicherte Settings)
          </h3>
          <ol className="border-rule divide-rule divide-y border">
            {entry.nextRuns.map((iso, i) => (
              <li key={iso} className="flex items-center gap-4 px-4 py-3 font-mono text-sm">
                <span className="text-ink-3 w-6 text-[0.7rem]">{i + 1}</span>
                <span className="text-ink">{formatRunDate(iso, entry.timezone)}</span>
                <span className="text-ink-3 ml-auto text-[0.7rem]">{iso}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : entry.cron && !entry.active ? (
        <div className="mt-6">
          <MnStatusBadge variant="default">
            scheduler deaktiviert — keine automatischen läufe
          </MnStatusBadge>
        </div>
      ) : !entry.cron ? (
        <div className="mt-6">
          <MnStatusBadge variant="default">kein zeitplan konfiguriert</MnStatusBadge>
        </div>
      ) : null}
    </section>
  )
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="border-rule border-r border-b p-4 last:border-r-0 md:border-b-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd className={`text-ink mt-1 text-base ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  )
}
