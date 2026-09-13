import type { ReactNode } from "react"
import type { RunStepSpec } from "#/lib/run-scope"
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
export function MetricsSection({
  metrics,
  footer,
}: {
  metrics?: RunMetricsSnapshot
  /** Zusatzzeile im selben Abschnitt (z. B. die Auflösungswege des Laufs). */
  footer?: ReactNode
}) {
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
      {footer}
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

/**
 * Dauerhaft geltende Bedingungen der Schritte — immer sichtbar, auch für
 * ausgeschaltete Schritte. Wer entscheidet, ob er einen Schritt einschaltet,
 * muss dessen Regeln vorher lesen können; ein Filter, der sich erst im
 * Ergebnis erklärt, sieht dort wie ein Fehler aus.
 */
export function StepNotes({ steps }: { steps: readonly RunStepSpec[] }) {
  const withNote = steps.filter((step) => step.note)
  if (withNote.length === 0) return null

  return (
    <dl className="border-rule mt-4 max-w-[560px] space-y-2 border-t pt-4">
      {withNote.map((step) => (
        <div key={step.key}>
          <dt className="text-ink-2 font-mono text-[0.7rem] tracking-[0.14em] uppercase">
            {step.label}
          </dt>
          {/* Fließtext in Inter statt Mono, und ink-2 statt ink-3: ink-3 liegt
              auf Weiß bei 2,82:1 und reißt in 11px die WCAG-AA-Grenze (4,5:1)
              deutlich. Genau diese Zeilen sollen VOR dem Einschalten eines
              schreibenden Schritts gelesen werden — sie dürfen nicht die am
              schlechtesten lesbaren der Seite sein. */}
          <dd className="text-ink-2 mt-1 max-w-[62ch] text-[0.8rem] leading-relaxed">
            {step.note}
          </dd>
        </div>
      ))}
    </dl>
  )
}
