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

export interface CustomerImportRow {
  lexwareContactId: string
  lexwareNumber?: string
  name: string
  vouchers: string[]
  dimaconCustomerId?: string
  status: "created" | "skipped" | "failed"
  reason?: string
}

export interface CustomerSyncError {
  scope: "customers" | "customer" | "mapping" | "import"
  refId?: string
  message: string
}

export interface CustomerSyncResult {
  dryRun: boolean
  durationMs: number
  /** optional: ältere Server-Versionen liefern das Feld nicht */
  steps?: { createContacts: boolean; alignNumbers: boolean; importFromLexware?: boolean }
  customers: CustomerAlignRow[]
  /** optional: Läufe vor der Übernahme Lexware → Dimacon kennen das Feld nicht */
  imports?: CustomerImportRow[]
  errors: CustomerSyncError[]
  /** optional: ältere Läufe/Server liefern keine Metriken */
  metrics?: RunMetricsSnapshot
}

const STEP_LABELS: Record<string, string> = {
  createContacts: "kontakte anlegen",
  alignNumbers: "nummern-abgleich",
}

/**
 * Opt-in-Schritte: „aus" ist der Normalfall und bekommt KEINE Warn-Badge
 * (gleiche Regel wie step-badges.ts). Gemeldet wird nur „an", neutral.
 */
const OPT_IN_LABELS: Record<string, string> = {
  importFromLexware: "übernahme aus lexware an",
}

const IMPORT_STATUSES = ["created", "skipped", "failed"] as const

export function DimaconLexofficeResult({ result }: { result: CustomerSyncResult }) {
  const counts = countByStatus(result.customers)
  const imports = result.imports ?? []
  const importCounts = countImportsByStatus(imports)
  // Ein Übernahme-Fehler (Index/Belege unvollständig) steht unter „Fehler" —
  // „nichts zu übernehmen" wäre dann eine falsche Entwarnung.
  const importFailed = result.errors.some((e) => e.scope === "import")

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
            ? Object.entries(result.steps).map(([step, on]) => {
                const optIn = OPT_IN_LABELS[step]
                if (optIn !== undefined) {
                  return on ? <MnStatusBadge key={step}>{optIn}</MnStatusBadge> : null
                }
                return on ? null : (
                  <MnStatusBadge key={step} variant="warn">
                    {STEP_LABELS[step] ?? step} aus
                  </MnStatusBadge>
                )
              })
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
          {IMPORT_STATUSES.map((s) =>
            importCounts[s] > 0 ? (
              <MnStatusBadge key={`import-${s}`} variant={badgeVariant(s)}>
                übernahme {s} · {importCounts[s]}
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

      {result.steps?.importFromLexware && !importFailed ? (
        <section className="mb-16">
          <ResultSectionHead title="Aus Lexware übernommen" />
          {imports.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead>Kunde</TableHead>
                  <TableHead className="w-32">Lexware-Nr.</TableHead>
                  <TableHead className="w-40">Belege</TableHead>
                  <TableHead>Hinweis</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {imports.map((row) => (
                  <TableRow key={row.lexwareContactId}>
                    <TableCell>
                      <MnStatusBadge variant={badgeVariant(row.status)}>{row.status}</MnStatusBadge>
                    </TableCell>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="font-mono text-[0.8rem]">
                      {row.lexwareNumber ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-[0.8rem]">
                      {row.vouchers.join(", ")}
                    </TableCell>
                    <TableCell className="text-ink-2 text-[0.8rem]">{row.reason ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-body-sm text-ink-2">
              Nichts zu übernehmen: Kein Lexware-Kunde mit Angebot oder Auftragsbestätigung der
              letzten 14 Tage fehlt in Dimacon.
            </p>
          )}
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

function badgeVariant(
  status: CustomerAlignRow["status"] | CustomerImportRow["status"],
): "default" | "ok" | "warn" {
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

function countImportsByStatus(
  rows: CustomerImportRow[],
): Record<CustomerImportRow["status"], number> {
  const counts: Record<CustomerImportRow["status"], number> = { created: 0, skipped: 0, failed: 0 }
  for (const r of rows) counts[r.status]++
  return counts
}
