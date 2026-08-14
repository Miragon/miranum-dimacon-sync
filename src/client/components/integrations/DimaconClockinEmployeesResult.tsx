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

export interface EmployeeSyncError {
  scope: "load" | "employee" | "mapping"
  refId?: string
  message: string
}

export interface EmployeeSyncResult {
  dryRun: boolean
  durationMs: number
  counts: { dimacon: number; clockin: number; matched: number }
  employees: EmployeeSyncRow[]
  errors: EmployeeSyncError[]
}

const DIRECTION_LABELS: Record<EmployeeSyncRow["direction"], string> = {
  "dimacon→clockin": "→ Clockin",
  "clockin→dimacon": "→ Dimacon",
  match: "Match",
}

export function DimaconClockinEmployeesResult({ result }: { result: EmployeeSyncResult }) {
  const counts = countByStatus(result.employees)

  return (
    <>
      <section className="mb-16">
        <ResultSectionHead title="Zusammenfassung" />
        <dl className="border-rule grid grid-cols-2 border md:grid-cols-6">
          <Stat label="Modus" value={result.dryRun ? "dry-run" : "live"} />
          <Stat label="Dauer" value={`${(result.durationMs / 1000).toFixed(1)}s`} />
          <Stat label="Dimacon" value={String(result.counts.dimacon)} />
          <Stat label="Clockin" value={String(result.counts.clockin)} />
          <Stat label="Matches" value={String(result.counts.matched)} />
          <Stat label="Fehler" value={String(result.errors.length)} />
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {(["created", "updated", "unchanged", "skipped", "reported", "failed"] as const).map(
            (s) =>
              counts[s] > 0 ? (
                <MnStatusBadge key={s} variant={badgeVariant(s)}>
                  {s} · {counts[s]}
                </MnStatusBadge>
              ) : null,
          )}
        </div>
      </section>

      {result.employees.length > 0 ? (
        <section className="mb-16">
          <ResultSectionHead title="Mitarbeiter" />
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
              {result.employees.map((row, i) => (
                <TableRow key={`${row.dimaconId ?? ""}-${row.clockinId ?? ""}-${i}`}>
                  <TableCell>
                    <MnStatusBadge variant={badgeVariant(row.status)}>{row.status}</MnStatusBadge>
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

function badgeVariant(status: EmployeeSyncStatus): "default" | "ok" | "warn" {
  if (status === "created" || status === "updated") return "ok"
  if (status === "failed" || status === "skipped" || status === "reported") return "warn"
  return "default"
}

function countByStatus(rows: EmployeeSyncRow[]): Record<EmployeeSyncStatus, number> {
  const counts: Record<EmployeeSyncStatus, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    reported: 0,
    failed: 0,
  }
  for (const row of rows) counts[row.status]++
  return counts
}
