import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table"

export function ResultSectionHead({ title }: { title: string }) {
  return (
    <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">{title}</h2>
  )
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-rule border-r border-b p-4 last:border-r-0 md:border-b-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd className="text-ink mt-1 font-mono text-base">{value}</dd>
    </div>
  )
}

const METRIC_SYSTEMS = ["dimacon", "clockin", "lexoffice"] as const

type MetricSystem = (typeof METRIC_SYSTEMS)[number]

const SYSTEM_LABELS: Record<MetricSystem, string> = {
  dimacon: "Dimacon",
  clockin: "Clockin",
  lexoffice: "Lexware",
}

export interface RunMetricsSnapshot {
  totalMs: number
  requests: Partial<Record<MetricSystem, number>>
  retries: number
  rateLimited: number
  waitedMs: number
  phases: {
    phase: string
    durationMs: number
    requests: Partial<Record<MetricSystem, number>>
    retries: number
    rateLimited: number
    waitedMs: number
  }[]
}

/**
 * Laufzeit-Messung eines Laufs. Wird nur gerendert, wenn das Ergebnis
 * Metriken trägt — ältere Läufe und ältere Server-Versionen bleiben
 * kompatibel.
 */
export function MetricsSection({ metrics }: { metrics?: RunMetricsSnapshot }) {
  if (!metrics) return null

  // Spalten nur für Systeme, die im Lauf überhaupt angefragt wurden.
  const systems = METRIC_SYSTEMS.filter((s) => (metrics.requests[s] ?? 0) > 0)
  const totalRequests = systems.reduce((sum, s) => sum + (metrics.requests[s] ?? 0), 0)

  return (
    <section className="mb-16">
      <ResultSectionHead title="Laufzeit" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Phase</TableHead>
            <TableHead className="w-24 text-right">Dauer</TableHead>
            {systems.map((s) => (
              <TableHead key={s} className="w-28 text-right">
                {SYSTEM_LABELS[s]}
              </TableHead>
            ))}
            <TableHead className="w-32 text-right">Wartezeit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {metrics.phases.map((phase, i) => (
            <TableRow key={`${phase.phase}-${i}`}>
              <TableCell className="font-mono text-[0.8rem]">{phase.phase}</TableCell>
              <TableCell className="text-right font-mono text-[0.8rem]">
                {seconds(phase.durationMs)}
              </TableCell>
              {systems.map((s) => (
                <TableCell key={s} className="text-right font-mono text-[0.8rem]">
                  {phase.requests[s] ?? 0}
                </TableCell>
              ))}
              <TableCell className="text-right font-mono text-[0.8rem]">
                {waitLabel(phase.waitedMs, phase.rateLimited)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="font-mono text-[0.8rem] font-medium">gesamt</TableCell>
            <TableCell className="text-right font-mono text-[0.8rem] font-medium">
              {seconds(metrics.totalMs)}
            </TableCell>
            {systems.map((s) => (
              <TableCell key={s} className="text-right font-mono text-[0.8rem] font-medium">
                {metrics.requests[s] ?? 0}
              </TableCell>
            ))}
            <TableCell className="text-right font-mono text-[0.8rem] font-medium">
              {waitLabel(metrics.waitedMs, metrics.rateLimited)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p className="text-ink-2 mt-3 text-[0.8rem]">
        {totalRequests} Requests, {metrics.retries} Wiederholungen (davon {metrics.rateLimited}{" "}
        wegen Rate-Limit). Parallel laufende Phasen überlappen — die Summe der Phasen-Dauern ist
        deshalb größer als die Gesamtdauer.
      </p>
    </section>
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function waitLabel(waitedMs: number, rateLimited: number): string {
  if (waitedMs === 0) return "—"
  return rateLimited > 0 ? `${seconds(waitedMs)} · ${rateLimited}× 429` : seconds(waitedMs)
}
