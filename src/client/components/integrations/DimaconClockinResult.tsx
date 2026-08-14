import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table"
import { ResultSectionHead, Stat } from "./bits.js"

export interface ProjectSyncResult {
  dimaconProjectId: string
  clockinProjectId?: number
  name: string
  status: "created" | "updated" | "unchanged" | "skipped" | "failed"
  employeesAttached?: number[]
  employeesDetached?: number[]
  reason?: string
}

export interface ArchiveResult {
  clockinProjectId: number
  name: string
}

export interface SyncError {
  scope: "appointments" | "enrichment" | "customer" | "employee" | "project" | "archive" | "mapping"
  refId?: string
  message: string
}

export interface SyncResult {
  date: string
  dryRun: boolean
  durationMs: number
  /** optional: ältere Server-Versionen liefern die Felder nicht */
  appointments?: { total: number; live: number }
  steps?: { customers: boolean; employees: boolean; projects: boolean; archive: boolean }
  projects: ProjectSyncResult[]
  archived: ArchiveResult[]
  errors: SyncError[]
}

const STEP_LABELS: Record<string, string> = {
  customers: "kunden",
  employees: "mitarbeiter",
  projects: "projekte",
  archive: "archivierung",
}

export function DimaconClockinResult({ result }: { result: SyncResult }) {
  const counts = countByStatus(result.projects)

  return (
    <>
      <section className="mb-16">
        <ResultSectionHead title="Zusammenfassung" />
        <dl className="border-rule grid grid-cols-2 border md:grid-cols-7">
          <Stat label="Datum" value={result.date} />
          <Stat label="Modus" value={result.dryRun ? "dry-run" : "live"} />
          <Stat label="Dauer" value={`${(result.durationMs / 1000).toFixed(1)}s`} />
          <Stat
            label="Termine"
            value={result.appointments ? String(result.appointments.live) : "—"}
          />
          <Stat label="Projekte" value={String(result.projects.length)} />
          <Stat label="Archiviert" value={String(result.archived.length)} />
          <Stat label="Fehler" value={String(result.errors.length)} />
        </dl>
        {result.appointments?.live === 0 && result.errors.length === 0 ? (
          <p className="text-ink-2 mt-4 text-[0.8rem]">
            Keine Termine in Dimacon für dieses Datum — es gibt nichts zu synchronisieren.
            {result.appointments.total > 0
              ? ` (${result.appointments.total} archivierte Termine wurden ignoriert.)`
              : ""}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {result.steps
            ? Object.entries(result.steps)
                .filter(([, on]) => !on)
                .map(([step]) => (
                  <MnStatusBadge key={step} variant="warn">
                    {STEP_LABELS[step] ?? step} aus
                  </MnStatusBadge>
                ))
            : null}
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
              {result.projects.map((p, i) => (
                <TableRow key={`${p.dimaconProjectId}-${i}`}>
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
