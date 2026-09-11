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
import { MetricsSection, ResultSectionHead, Stat, type RunMetricsSnapshot } from "./bits.js"
import { stepBadges } from "./step-badges.js"

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
  scope:
    | "appointments"
    | "enrichment"
    | "customer"
    | "employee"
    | "project"
    | "archive"
    | "mapping"
    | "load"
  refId?: string
  message: string
}

export type EmployeeSyncStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped"
  | "reported"
  | "failed"

export interface EmployeeSyncRow {
  direction: "dimacon→clockin" | "clockin→dimacon" | "match"
  dimaconId?: string
  clockinId?: number
  name: string
  status: EmployeeSyncStatus
  reason?: string
}

export interface SyncResult {
  date: string
  dryRun: boolean
  durationMs: number
  /** optional: ältere Server-Versionen liefern die Felder nicht */
  appointments?: { total: number; live: number }
  steps?: {
    employees: boolean
    customers: boolean
    projects: boolean
    assignments: boolean
    archive: boolean
    /** optional: ältere persistierte Ergebnisse kennen den Schalter nicht */
    employeeCreateInDimacon?: boolean
  }
  employeeSync?: {
    counts: { dimacon: number; clockin: number; matched: number }
    rows: EmployeeSyncRow[]
  }
  projects: ProjectSyncResult[]
  archived: ArchiveResult[]
  errors: SyncError[]
  /** optional: ältere Läufe/Server liefern keine Metriken */
  metrics?: RunMetricsSnapshot
  /** optional: welche Auflösungswege der Lauf genommen hat (#15) */
  lookups?: {
    jobs?: string
    teamAssignments?: string
    projects?: string
    customers?: string
    clockinCustomerIndex?: boolean
    clockinProjectPrefetch?: string
    archiveHorizonDays?: number
  }
}

/**
 * Jede Bündelung hat einen Einzelabruf-Fallback — ohne diese Zeile wäre nicht
 * erkennbar, ob die Optimierung greift oder der Lauf still auf den alten,
 * langsamen Pfad gefallen ist.
 */
function LookupsNote({ lookups }: { lookups: NonNullable<SyncResult["lookups"]> }) {
  const parts: string[] = []
  if (lookups.jobs) parts.push(`Aufträge ${BULK_LABELS[lookups.jobs] ?? lookups.jobs}`)
  if (lookups.projects)
    parts.push(`Dimacon-Projekte ${BULK_LABELS[lookups.projects] ?? lookups.projects}`)
  if (lookups.customers)
    parts.push(`Dimacon-Kunden ${BULK_LABELS[lookups.customers] ?? lookups.customers}`)
  if (lookups.clockinProjectPrefetch)
    parts.push(
      `Clockin-Projekte ${BULK_LABELS[lookups.clockinProjectPrefetch] ?? lookups.clockinProjectPrefetch}`,
    )
  if (lookups.clockinCustomerIndex !== undefined)
    parts.push(`Clockin-Kunden ${lookups.clockinCustomerIndex ? "aus dem Index" : "einzeln"}`)

  return (
    <p className="text-ink-2 -mt-12 mb-16 text-[0.8rem]">
      <span className="font-mono">Auflösung:</span> {parts.join(" · ")}
      {lookups.archiveHorizonDays !== undefined
        ? ` · Archiv-Horizont ±${lookups.archiveHorizonDays} Tage`
        : ""}
    </p>
  )
}

/** Deutsche Kurzlabel der Auflösungswege. */
const BULK_LABELS: Record<string, string> = {
  period: "gebündelt",
  bundled: "gebündelt",
  bulk: "gebündelt",
  preloaded: "vorgeladen",
  "per-job": "einzeln",
  "per-id": "einzeln",
  none: "nicht geladen",
  off: "einzeln",
}

const DIRECTION_LABELS: Record<EmployeeSyncRow["direction"], string> = {
  "dimacon→clockin": "→ Clockin",
  "clockin→dimacon": "→ Dimacon",
  match: "Match",
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
            Keine Termine in Dimacon für dieses Datum — Tagesplanung übersprungen
            {result.employeeSync && result.employeeSync.rows.length > 0
              ? ", nur der Mitarbeiter-Abgleich lief."
              : ", es gibt nichts zu synchronisieren."}
            {result.appointments.total > 0
              ? ` (${result.appointments.total} archivierte Termine wurden ignoriert.)`
              : ""}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {stepBadges(result.steps).map((badge) => (
            <MnStatusBadge key={badge.key} variant={badge.variant}>
              {badge.label}
            </MnStatusBadge>
          ))}
          {(["created", "updated", "unchanged", "skipped", "failed"] as const).map((s) =>
            counts[s] > 0 ? (
              <MnStatusBadge key={s} variant={badgeVariant(s)}>
                {s} · {counts[s]}
              </MnStatusBadge>
            ) : null,
          )}
        </div>
      </section>

      <MetricsSection
        metrics={result.metrics}
        footer={result.lookups ? <LookupsNote lookups={result.lookups} /> : null}
      />

      {result.employeeSync ? (
        <section className="mb-16">
          <ResultSectionHead title="Mitarbeiter-Abgleich" />
          <dl className="border-rule grid grid-cols-3 border">
            <Stat label="Dimacon" value={String(result.employeeSync.counts.dimacon)} />
            <Stat label="Clockin" value={String(result.employeeSync.counts.clockin)} />
            <Stat label="Matches" value={String(result.employeeSync.counts.matched)} />
          </dl>
          {result.employeeSync.rows.length > 0 ? (
            <div className="mt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Status</TableHead>
                    <TableHead className="w-32">Richtung</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Hinweis</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.employeeSync.rows.map((row, i) => (
                    <TableRow key={`${row.dimaconId ?? ""}-${row.clockinId ?? ""}-${i}`}>
                      <TableCell>
                        <MnStatusBadge variant={employeeBadgeVariant(row.status)}>
                          {row.status}
                        </MnStatusBadge>
                      </TableCell>
                      <TableCell className="font-mono text-[0.8rem]">
                        {DIRECTION_LABELS[row.direction]}
                      </TableCell>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell className="text-ink-2 text-[0.8rem]">{row.reason ?? ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </section>
      ) : null}

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

function employeeBadgeVariant(status: EmployeeSyncStatus): "default" | "ok" | "warn" {
  if (status === "created" || status === "updated") return "ok"
  if (status === "failed" || status === "skipped" || status === "reported") return "warn"
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
