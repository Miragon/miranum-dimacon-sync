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

export interface SevdeskAlignRow {
  dimaconCustomerId: string
  name: string
  sevdeskContactId?: string
  sevdeskNumber?: string
  status: "created" | "aligned" | "unchanged" | "ambiguous" | "conflict" | "skipped" | "failed"
  reason?: string
}

export interface SevdeskSyncError {
  scope: "customers" | "customer" | "mapping"
  refId?: string
  message: string
}

export interface SevdeskSyncResult {
  dryRun: boolean
  durationMs: number
  /** optional: ältere Server-Versionen liefern das Feld nicht */
  steps?: { createContacts: boolean; alignNumbers: boolean }
  customers: SevdeskAlignRow[]
  errors: SevdeskSyncError[]
  /** optional: ältere Läufe/Server liefern keine Metriken */
  metrics?: RunMetricsSnapshot
}

const STEP_LABELS: Record<string, string> = {
  createContacts: "kontakte anlegen",
  alignNumbers: "nummern-abgleich",
}

export function DimaconSevdeskResult({ result }: { result: SevdeskSyncResult }) {
  const counts = countByStatus(result.customers)

  return (
    <>
      <section className="mb-16">
        <ResultSectionHead title="Zusammenfassung" />
        <dl className="border-rule grid grid-cols-2 border md:grid-cols-4">
          <Stat label="Modus" value={result.dryRun ? "dry-run" : "live"} />
          <Stat label="Dauer" value={`${(result.durationMs / 1000).toFixed(1)}s`} />
          <Stat label="Kunden" value={String(result.customers.length)} />
          <Stat label="Fehler" value={String(result.errors.length)} />
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {result.steps
            ? Object.entries(result.steps).map(([step, on]) =>
                on ? null : (
                  <MnStatusBadge key={step} variant="warn">
                    {STEP_LABELS[step] ?? step} aus
                  </MnStatusBadge>
                ),
              )
            : null}
          {(
            [
              "created",
              "aligned",
              "unchanged",
              "ambiguous",
              "conflict",
              "skipped",
              "failed",
            ] as const
          ).map((s) =>
            counts[s] > 0 ? (
              <MnStatusBadge key={s} variant={badgeVariant(s)}>
                {s} · {counts[s]}
              </MnStatusBadge>
            ) : null,
          )}
        </div>
      </section>

      <MetricsSection metrics={result.metrics} />

      {result.customers.length > 0 ? (
        <section className="mb-16">
          <ResultSectionHead title="Kunden" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Status</TableHead>
                <TableHead>Kunde</TableHead>
                <TableHead className="w-32">sevDesk-Nr.</TableHead>
                <TableHead className="w-72">sevDesk-Kontakt</TableHead>
                <TableHead>Hinweis</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.customers.map((c) => (
                <TableRow key={c.dimaconCustomerId}>
                  <TableCell>
                    <MnStatusBadge variant={badgeVariant(c.status)}>{c.status}</MnStatusBadge>
                  </TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="font-mono text-[0.8rem]">
                    {c.sevdeskNumber ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-[0.8rem]">
                    {c.sevdeskContactId ?? "—"}
                  </TableCell>
                  <TableCell className="text-ink-2 text-[0.8rem]">{c.reason ?? ""}</TableCell>
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

function badgeVariant(status: SevdeskAlignRow["status"]): "default" | "ok" | "warn" {
  if (status === "created" || status === "aligned") return "ok"
  // ambiguous/conflict: bewusst nichts geschrieben — braucht eine Entscheidung
  if (status !== "unchanged") return "warn"
  return "default"
}

function countByStatus(rows: SevdeskAlignRow[]): Record<SevdeskAlignRow["status"], number> {
  const counts: Record<SevdeskAlignRow["status"], number> = {
    created: 0,
    aligned: 0,
    unchanged: 0,
    ambiguous: 0,
    conflict: 0,
    skipped: 0,
    failed: 0,
  }
  for (const r of rows) counts[r.status]++
  return counts
}
