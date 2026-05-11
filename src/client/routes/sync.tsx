import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { useApiFetch } from "#/lib/api"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table"

export const Route = createFileRoute("/sync")({ component: SyncPage })

interface ProjectSyncResult {
  dimaconProjectId: string
  clockinProjectId?: number
  name: string
  status: "created" | "updated" | "unchanged" | "skipped" | "failed"
  employeesAttached?: number[]
  employeesDetached?: number[]
  reason?: string
}

interface ArchiveResult {
  clockinProjectId: number
  name: string
}

interface SyncError {
  scope: "appointments" | "enrichment" | "customer" | "employee" | "project" | "archive"
  refId?: string
  message: string
}

interface SyncResult {
  date: string
  dryRun: boolean
  durationMs: number
  projects: ProjectSyncResult[]
  archived: ArchiveResult[]
  errors: SyncError[]
}

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function SyncPage() {
  const [date, setDate] = useState<string>(todayISO())
  const [dryRun, setDryRun] = useState<boolean>(true)
  const [running, setRunning] = useState<boolean>(false)
  const [result, setResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const apiFetch = useApiFetch()

  async function run() {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch("/api/sync/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, dryRun }),
      })
      const json = (await res.json()) as SyncResult | { error: string }
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        setResult(json as SyncResult)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <header className="mb-12">
        <span className="mn-mono">/sync · clockin × dimacon</span>
        <h1 className="text-h-1 text-ink mt-4">Clockin · Dimacon Sync</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[540px]">
          Tagesplanung aus Dimacon nach Clockin übertragen — Termine laden, Projekte upserten,
          Mitarbeiter zuweisen, nicht eingeplante archivieren.
        </p>
      </header>

      <section className="mb-16">
        <div className="border-rule flex flex-wrap items-end gap-6 border p-6">
          <div className="w-[180px]">
            <Label htmlFor="sync-date">Datum</Label>
            <Input
              id="sync-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-2"
              disabled={running}
            />
          </div>
          <div>
            <Label htmlFor="sync-dry-run">Modus</Label>
            <label
              htmlFor="sync-dry-run"
              className="border-ink bg-paper text-ink mt-2 flex h-10 cursor-pointer items-center gap-3 border px-3 text-sm select-none"
            >
              <input
                id="sync-dry-run"
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
            <Button onClick={run} disabled={running} variant={dryRun ? "default" : "accent"}>
              {running ? "läuft …" : dryRun ? "Dry-Run starten" : "Sync starten"}
            </Button>
          </div>
        </div>
        {error ? (
          <MnAlert label="Fehler" className="mt-6">
            {error}
          </MnAlert>
        ) : null}
      </section>

      {result ? <ResultView result={result} /> : null}
    </>
  )
}

function ResultView({ result }: { result: SyncResult }) {
  const counts = countByStatus(result.projects)

  return (
    <>
      <section className="mb-16">
        <ResultSectionHead title="Zusammenfassung" />
        <dl className="border-rule grid grid-cols-2 border md:grid-cols-6">
          <Stat label="Datum" value={result.date} />
          <Stat label="Modus" value={result.dryRun ? "dry-run" : "live"} />
          <Stat label="Dauer" value={`${(result.durationMs / 1000).toFixed(1)}s`} />
          <Stat label="Projekte" value={String(result.projects.length)} />
          <Stat label="Archiviert" value={String(result.archived.length)} />
          <Stat label="Fehler" value={String(result.errors.length)} />
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {(["created", "updated", "unchanged", "skipped", "failed"] as const).map((s) =>
            counts[s] > 0 ? (
              <MnStatusBadge key={s} variant={badgeVariant(s)}>
                {s} · {counts[s]}
              </MnStatusBadge>
            ) : null,
          )}
        </div>
      </section>

      {result.projects.length > 0 ? (
        <section className="mb-16">
          <ResultSectionHead title="Projekte" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Status</TableHead>
                <TableHead>Projekt</TableHead>
                <TableHead className="w-28">Clockin-ID</TableHead>
                <TableHead className="w-24">Mitarbeiter</TableHead>
                <TableHead>Hinweis</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.projects.map((p) => (
                <TableRow key={p.dimaconProjectId}>
                  <TableCell>
                    <MnStatusBadge variant={badgeVariant(p.status)}>{p.status}</MnStatusBadge>
                  </TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="font-mono text-[0.8rem]">
                    {p.clockinProjectId ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-[0.8rem]">{employeeDelta(p)}</TableCell>
                  <TableCell className="text-ink-2 text-[0.8rem]">{p.reason ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {result.archived.length > 0 ? (
        <section className="mb-16">
          <ResultSectionHead title="Archiviert" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Clockin-ID</TableHead>
                <TableHead>Projekt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.archived.map((a) => (
                <TableRow key={a.clockinProjectId}>
                  <TableCell className="font-mono text-[0.8rem]">{a.clockinProjectId}</TableCell>
                  <TableCell>{a.name}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {result.errors.length > 0 ? (
        <section>
          <ResultSectionHead title="Fehler" />
          <div className="space-y-3">
            {result.errors.map((e, i) => (
              <MnAlert key={i} label={`${e.scope}${e.refId ? ` · ${e.refId}` : ""}`}>
                {e.message}
              </MnAlert>
            ))}
          </div>
        </section>
      ) : null}
    </>
  )
}

function ResultSectionHead({ title }: { title: string }) {
  return (
    <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">{title}</h2>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-rule border-r border-b p-4 last:border-r-0 md:border-b-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd className="text-ink mt-1 font-mono text-base">{value}</dd>
    </div>
  )
}

function badgeVariant(status: ProjectSyncResult["status"]): "default" | "ok" | "warn" {
  if (status === "created" || status === "updated") return "ok"
  if (status === "failed" || status === "skipped") return "warn"
  return "default"
}

function countByStatus(projects: ProjectSyncResult[]): Record<ProjectSyncResult["status"], number> {
  const counts: Record<ProjectSyncResult["status"], number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  }
  for (const p of projects) counts[p.status]++
  return counts
}

function employeeDelta(p: ProjectSyncResult): string {
  const add = p.employeesAttached?.length ?? 0
  const rem = p.employeesDetached?.length ?? 0
  if (add === 0 && rem === 0) return "—"
  if (rem === 0) return `+${add}`
  if (add === 0) return `−${rem}`
  return `+${add} / −${rem}`
}
