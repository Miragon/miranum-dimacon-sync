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

export interface CustomerAlignRow {
  dimaconCustomerId: string
  name: string
  lexwareContactId?: string
  lexwareNumber?: string
  status: "created" | "aligned" | "unchanged" | "ambiguous" | "conflict" | "skipped" | "failed"
  reason?: string
}

export interface CustomerSyncError {
  scope: "customers" | "customer" | "mapping"
  refId?: string
  message: string
}

export interface CustomerSyncResult {
  dryRun: boolean
  durationMs: number
  /** optional: ältere Server-Versionen liefern das Feld nicht */
  steps?: { createContacts: boolean; alignNumbers: boolean }
  customers: CustomerAlignRow[]
  errors: CustomerSyncError[]
  /** optional: ältere Läufe/Server liefern keine Metriken */
  metrics?: RunMetricsSnapshot
}

const STEP_LABELS: Record<string, string> = {
  createContacts: "kontakte anlegen",
  alignNumbers: "nummern-abgleich",
}

export function DimaconLexofficeResult({ result }: { result: CustomerSyncResult }) {
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
            ? Object.entries(result.steps)
                .filter(([, on]) => !on)
                .map(([step]) => (
                  <MnStatusBadge key={step} variant="warn">
                    {STEP_LABELS[step] ?? step} aus
                  </MnStatusBadge>
                ))
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
                <TableHead className="w-32">Lexware-Nr.</TableHead>
                <TableHead className="w-72">Lexware-Kontakt</TableHead>
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
                    {c.lexwareNumber ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-[0.8rem]">
                    {c.lexwareContactId ?? "—"}
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

function badgeVariant(status: CustomerAlignRow["status"]): "default" | "ok" | "warn" {
  if (status === "created" || status === "aligned") return "ok"
  // ambiguous/conflict: bewusst nichts geschrieben — braucht eine Entscheidung
  if (status !== "unchanged") return "warn"
  return "default"
}

function countByStatus(rows: CustomerAlignRow[]): Record<CustomerAlignRow["status"], number> {
  const counts: Record<CustomerAlignRow["status"], number> = {
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
