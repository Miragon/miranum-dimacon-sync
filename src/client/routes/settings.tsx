import { createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { useApiFetch } from "#/lib/api"
import { formatRunDate } from "#/lib/integrations"

export const Route = createFileRoute("/settings")({ component: SettingsPage })

interface ScheduleEntry {
  id: string
  name: string
  enabled: boolean
  cron?: string
  timezone: string
  active: boolean
  nextRun: string | null
  nextRuns: string[]
}

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "Täglich 06:00", expr: "0 6 * * *" },
  { label: "Werktags 06:00", expr: "0 6 * * 1-5" },
  { label: "Stündlich", expr: "0 * * * *" },
  { label: "Alle 15 min", expr: "*/15 * * * *" },
]

function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const apiFetch = useApiFetch()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch("/api/settings/integrations")
      const json = (await res.json()) as ScheduleEntry[] | { error: string }
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        setEntries(json as ScheduleEntry[])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <header className="mb-12">
        <span className="mn-mono">/settings · scheduler</span>
        <h1 className="text-h-1 text-ink mt-4">Settings</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[540px]">
          Zeitpläne für die automatischen Läufe — pro Integration ein eigener Cron. Änderungen
          werden sofort wirksam, der jeweilige Scheduler startet beim Speichern neu.
        </p>
      </header>

      {error ? (
        <MnAlert label="Fehler" className="mb-8">
          {error}
        </MnAlert>
      ) : null}

      {loading ? (
        <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">lade …</p>
      ) : (
        <div className="space-y-16">
          {entries.map((entry) => (
            <ScheduleCard
              key={entry.id}
              entry={entry}
              onSaved={(updated) =>
                setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
              }
            />
          ))}
        </div>
      )}
    </>
  )
}

function ScheduleCard({
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
  const [cron, setCron] = useState(entry.cron ?? "")
  const [timezone, setTimezone] = useState(entry.timezone)
  const apiFetch = useApiFetch()

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const body = {
        enabled,
        cron: cron.trim().length > 0 ? cron.trim() : undefined,
        timezone: timezone.trim(),
      }
      const res = await apiFetch(`/api/settings/integrations/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as ScheduleEntry | { error: string }
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        const updated = json as ScheduleEntry
        setEnabled(updated.enabled)
        setCron(updated.cron ?? "")
        setTimezone(updated.timezone)
        setNotice("Gespeichert. Scheduler neu gestartet.")
        onSaved(updated)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const dirty =
    enabled !== entry.enabled ||
    (cron.trim() || undefined) !== entry.cron ||
    timezone.trim() !== entry.timezone

  const fieldId = (suffix: string) => `${entry.id}-${suffix}`

  return (
    <section>
      <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
        {entry.name}
      </h2>

      <dl className="border-rule mb-6 grid grid-cols-2 border md:grid-cols-4">
        <Stat label="Cron aktiv" value={entry.active ? "ja" : "nein"} />
        <Stat label="Aktueller Ausdruck" value={entry.cron ?? "—"} mono />
        <Stat label="Zeitzone" value={entry.timezone} />
        <Stat
          label="Nächster Lauf"
          value={entry.nextRun ? formatRunDate(entry.nextRun, entry.timezone) : "—"}
        />
      </dl>

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
          <Label htmlFor={fieldId("cron")}>Cron-Ausdruck</Label>
          <Input
            id={fieldId("cron")}
            type="text"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 6 * * *"
            className="mt-2 font-mono"
            disabled={saving}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.expr}
                type="button"
                onClick={() => setCron(p.expr)}
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
          <Button onClick={save} disabled={saving || !dirty}>
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

      {entry.nextRuns.length > 0 ? (
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
      ) : !entry.cron ? (
        <div className="mt-6">
          <MnStatusBadge variant="default">kein cron konfiguriert</MnStatusBadge>
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
