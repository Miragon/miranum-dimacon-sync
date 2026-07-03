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

export interface CustomerAlignRow {
  dimaconCustomerId: string
  name: string
  lexwareContactId?: string
  lexwareNumber?: string
  status: "created" | "aligned" | "unchanged" | "failed"
  reason?: string
}

export interface CustomerSyncError {
  scope: "appointments" | "jobs" | "customers" | "customer"
  refId?: string
  message: string
}

export interface CustomerSyncResult {
  date: string
  dryRun: boolean
  durationMs: number
  customers: CustomerAlignRow[]
  errors: CustomerSyncError[]
}

export function DimaconLexofficeResult({ result }: { result: CustomerSyncResult }) {
  const counts = countByStatus(result.customers)

  return (
    <>
      <section className="mb-16">
        <ResultSectionHead title="Zusammenfassung" />
        <dl className="border-rule grid grid-cols-2 border md:grid-cols-5">
          <Stat label="Datum" value={result.date} />
          <Stat label="Modus" value={result.dryRun ? "dry-run" : "live"} />
          <Stat label="Dauer" value={`${(result.durationMs / 1000).toFixed(1)}s`} />
          <Stat label="Kunden" value={String(result.customers.length)} />
          <Stat label="Fehler" value={String(result.errors.length)} />
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {(["created", "aligned", "unchanged", "failed"] as const).map((s) =>
            counts[s] > 0 ? (
              <MnStatusBadge key={s} variant={badgeVariant(s)}>
                {s} · {counts[s]}
              </MnStatusBadge>
            ) : null,
          )}
        </div>
      </section>

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
  if (status === "failed") return "warn"
  return "default"
}

function countByStatus(rows: CustomerAlignRow[]): Record<CustomerAlignRow["status"], number> {
  const counts: Record<CustomerAlignRow["status"], number> = {
    created: 0,
    aligned: 0,
    unchanged: 0,
    failed: 0,
  }
  for (const r of rows) counts[r.status]++
  return counts
}
