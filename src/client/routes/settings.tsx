import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"

export const Route = createFileRoute("/settings")({ component: SettingsPage })

interface SyncSettings {
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [cron, setCron] = useState("")
  const [timezone, setTimezone] = useState("Europe/Berlin")
  const [server, setServer] = useState<SyncSettings | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/sync")
      const json = (await res.json()) as SyncSettings | { error: string }
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        const s = json as SyncSettings
        setServer(s)
        setEnabled(s.enabled)
        setCron(s.cron ?? "")
        setTimezone(s.timezone)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

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
      const res = await fetch("/api/settings/sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as SyncSettings | { error: string }
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        const s = json as SyncSettings
        setServer(s)
        setEnabled(s.enabled)
        setCron(s.cron ?? "")
        setTimezone(s.timezone)
        setNotice("Gespeichert. Scheduler neu gestartet.")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const dirty =
    server !== null &&
    (enabled !== server.enabled ||
      (cron.trim() || undefined) !== server.cron ||
      timezone.trim() !== server.timezone)

  return (
    <>
      <header className="mb-12">
        <span className="mn-mono">/settings · sync scheduler</span>
        <h1 className="text-h-1 text-ink mt-4">Sync Settings</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[540px]">
          Zeitplan für den automatischen Dimacon → Clockin Sync. Änderungen werden sofort wirksam —
          der Scheduler startet beim Speichern neu.
        </p>
      </header>

      {loading ? (
        <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">lade …</p>
      ) : (
        <>
          <section className="mb-12">
            <SectionHead title="Status" />
            <dl className="border-rule grid grid-cols-2 border md:grid-cols-4">
              <Stat
                label="Cron aktiv"
                value={server?.active ? "ja" : "nein"}
                accent={server?.active}
              />
              <Stat label="Aktueller Ausdruck" value={server?.cron ?? "—"} mono />
              <Stat label="Zeitzone" value={server?.timezone ?? "—"} />
              <Stat
                label="Nächster Lauf"
                value={server?.nextRun ? formatDate(server.nextRun, server.timezone) : "—"}
              />
            </dl>
          </section>

          <section className="mb-12">
            <SectionHead title="Konfiguration" />
            <div className="border-rule space-y-6 border p-6">
              <div>
                <Label htmlFor="settings-enabled">Automatischer Sync</Label>
                <label
                  htmlFor="settings-enabled"
                  className="border-ink bg-paper text-ink mt-2 flex h-10 cursor-pointer items-center gap-3 border px-3 text-sm select-none"
                >
                  <input
                    id="settings-enabled"
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
                <Label htmlFor="settings-cron">Cron-Ausdruck</Label>
                <Input
                  id="settings-cron"
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
                <Label htmlFor="settings-tz">Zeitzone</Label>
                <Input
                  id="settings-tz"
                  type="text"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="Europe/Berlin"
                  className="mt-2 font-mono"
                  disabled={saving}
                />
              </div>

              <div className="flex items-center gap-4 pt-2">
                <Button onClick={save} disabled={saving || !dirty} variant="accent">
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
              <div className="border-rule text-ink-2 mt-6 border border-l-[3px] border-l-emerald-600 px-4 py-3 text-sm">
                <strong className="mb-1.5 block font-mono text-[0.7rem] font-semibold tracking-[0.18em] text-emerald-700 uppercase">
                  OK
                </strong>
                {notice}
              </div>
            ) : null}
          </section>

          {server && server.nextRuns.length > 0 ? (
            <section>
              <SectionHead title="Nächste 5 Läufe (gespeicherte Settings)" />
              <ol className="border-rule divide-rule divide-y border">
                {server.nextRuns.map((iso, i) => (
                  <li key={iso} className="flex items-center gap-4 px-4 py-3 font-mono text-sm">
                    <span className="text-ink-3 w-6 text-[0.7rem]">{i + 1}</span>
                    <span className="text-ink">{formatDate(iso, server.timezone)}</span>
                    <span className="text-ink-3 ml-auto text-[0.7rem]">{iso}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : server && !server.cron ? (
            <MnStatusBadge variant="default">kein cron konfiguriert</MnStatusBadge>
          ) : null}
        </>
      )}
    </>
  )
}

function SectionHead({ title }: { title: string }) {
  return (
    <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">{title}</h2>
  )
}

function Stat({
  label,
  value,
  mono,
  accent,
}: {
  label: string
  value: string
  mono?: boolean
  accent?: boolean
}) {
  return (
    <div className="border-rule border-r border-b p-4 last:border-r-0 md:border-b-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd
        className={`mt-1 text-base ${mono ? "font-mono" : ""} ${
          accent ? "text-mn-accent" : "text-ink"
        }`}
      >
        {value}
      </dd>
    </div>
  )
}

function formatDate(iso: string, tz: string): string {
  try {
    const d = new Date(iso)
    return new Intl.DateTimeFormat("de-DE", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d)
  } catch {
    return iso
  }
}
