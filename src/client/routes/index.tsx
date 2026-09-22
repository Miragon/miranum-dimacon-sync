import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { Skeleton } from "#/components/ui/skeleton"
import { readJson, useApiFetch } from "#/lib/api"
import { formatRunDate, type IntegrationInfo, type RunHistoryEntry } from "#/lib/integrations"
import { describeScope } from "#/lib/run-scope"

export const Route = createFileRoute("/")({ component: Dashboard })

interface Row {
  info: IntegrationInfo
  lastRun?: RunHistoryEntry
}

/**
 * Einstieg für den täglichen Blick: „Lief der Sync? Gab es Fehler? Wann läuft
 * der nächste?" — genau die drei Fragen, für die vorher zwei Klicks nötig
 * waren, weil hier nur zwei statische Kacheln standen.
 *
 * Bewusst KEIN ElementBox-Hero mehr: die Kacheln haben auf die Zielseite
 * verlinkt, ohne etwas über deren Zustand zu sagen. Die Navigation dorthin
 * steht ohnehin in der Top-Nav.
 */
function Dashboard() {
  const apiFetch = useApiFetch()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch("/api/integrations")
      const json = await readJson<IntegrationInfo[] | { error: string }>(res)
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
        return
      }
      const infos = json as IntegrationInfo[]
      // Je Integration den letzten Lauf — ein Request pro Integration, bei
      // zwei Integrationen billiger als ein neuer Sammel-Endpunkt.
      const runs = await Promise.all(
        infos.map(async (info) => {
          try {
            const r = await apiFetch(`/api/integrations/${info.id}/runs?limit=1`)
            if (!r.ok) return undefined
            const list = await readJson<RunHistoryEntry[]>(r)
            return Array.isArray(list) ? list[0] : undefined
          } catch {
            // Ein fehlender Verlauf darf das Dashboard nicht kippen.
            return undefined
          }
        }),
      )
      setRows(infos.map((info, i) => ({ info, lastRun: runs[i] })))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    void load()
  }, [load])

  const needsAttention = rows.filter(
    (r) => !r.info.configured || r.lastRun?.status === "error" || r.lastRun?.status === "skipped",
  )

  return (
    <>
      <header className="mb-12">
        <span className="mn-mono">übersicht · sync</span>
        <h1 className="text-h-display text-ink mt-4 max-md:text-[3rem]">Miranum.</h1>
        <p className="text-body-lg text-ink-2 mt-6 max-w-[580px]">
          Stand der Sync-Abläufe zwischen Dimacon, Clockin, Lexware Office und sevDesk.
        </p>
      </header>

      {error ? (
        <MnAlert label="Fehler" className="mb-8">
          {error}
        </MnAlert>
      ) : null}

      {/* Der einzige Grund, warum jemand hier länger als drei Sekunden bleibt. */}
      {!loading && needsAttention.length > 0 ? (
        <section className="border-mn-accent mb-12 border-l-[3px] pl-6">
          <h2 className="mn-mono-accent mb-4">Braucht Aufmerksamkeit</h2>
          <ul className="space-y-2">
            {needsAttention.map(({ info, lastRun }) => (
              <li key={info.id} className="text-body">
                <Link
                  to="/sync/$integrationId"
                  params={{ integrationId: info.id }}
                  className="text-ink underline underline-offset-4"
                >
                  {info.name}
                </Link>
                <span className="text-ink-2">
                  {" — "}
                  {!info.configured
                    ? `Zugangsdaten fehlen: ${info.missingCredentials.join(", ")}`
                    : lastRun?.status === "skipped"
                      ? "letzter geplanter Lauf wurde übersprungen"
                      : "letzter Lauf mit Fehler"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-ink mb-6 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
          Integrationen
        </h2>
        {loading ? (
          <div className="grid gap-6 md:grid-cols-2">
            <Skeleton className="h-[168px]" />
            <Skeleton className="h-[168px]" />
            <Skeleton className="h-[168px]" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-body text-ink-2">Keine Integrationen registriert.</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {rows.map((row) => (
              <IntegrationCard key={row.info.id} {...row} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function IntegrationCard({ info, lastRun }: Row) {
  return (
    <Link
      to="/sync/$integrationId"
      params={{ integrationId: info.id }}
      className="group focus-visible:outline-mn-accent block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <article className="border-rule group-hover:border-ink flex h-full flex-col border p-5 transition-colors">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-h-4 text-ink">{info.name}</h3>
          {/* Bewusst `default`: die rote Markierung hat der Block „Braucht
              Aufmerksamkeit" oben — zweimal Akzent auf einem Screen entwertet ihn. */}
          {info.configured ? null : <MnStatusBadge>unvollständig</MnStatusBadge>}
        </div>
        <p className="text-ink-3 mt-1 font-mono text-[0.7rem] tracking-[0.12em]">
          {info.systems.join(" → ")}
        </p>

        <dl className="mt-5 space-y-2 text-[0.8rem]">
          <Row label="Letzter Lauf">
            {lastRun ? (
              <span className="flex flex-wrap items-center gap-2">
                <LastRunBadge status={lastRun.status} />
                <span className="text-ink-2 font-mono">{formatRunDate(lastRun.startedAt)}</span>
              </span>
            ) : (
              <span className="text-ink-2">noch keiner</span>
            )}
          </Row>
          <Row label="Nächster Lauf">
            <span className="text-ink-2 font-mono">
              {info.nextRun ? formatRunDate(info.nextRun) : info.cronActive ? "—" : "kein Zeitplan"}
            </span>
          </Row>
          <Row label="Umfang">
            <span className="text-ink-2 font-mono">{describeScope(info.id, info.runDefaults)}</span>
          </Row>
        </dl>

        <span className="text-ink-3 group-hover:text-ink mt-auto inline-flex items-center gap-1.5 pt-5 font-mono text-[0.7rem] tracking-[0.18em] uppercase transition-colors">
          Öffnen <span aria-hidden>→</span>
        </span>
      </article>
    </Link>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // Bei 375px reicht die Breite nicht für Label + Wert nebeneinander — dort
    // untereinander statt mit umbrechendem Wert.
    <div className="flex flex-col gap-x-3 gap-y-0.5 sm:flex-row">
      <dt className="text-ink-3 shrink-0 font-mono text-[0.65rem] tracking-[0.14em] uppercase sm:w-28 sm:pt-0.5">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function LastRunBadge({ status }: { status: RunHistoryEntry["status"] }) {
  if (status === "success") return <MnStatusBadge variant="ok">ok</MnStatusBadge>
  if (status === "error") return <MnStatusBadge variant="warn">fehler</MnStatusBadge>
  if (status === "skipped") return <MnStatusBadge>übersprungen</MnStatusBadge>
  return <MnStatusBadge>läuft</MnStatusBadge>
}
