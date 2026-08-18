import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { RunForm } from "#/components/integrations/RunForm"
import { RunResultView } from "#/components/integrations/RunResultView"
import { readJson, useApiFetch } from "#/lib/api"
import { formatRunDate } from "#/lib/integrations"
import type { IntegrationInfo } from "#/lib/integrations"

export const Route = createFileRoute("/sync/$integrationId")({ component: IntegrationDetailPage })

function IntegrationDetailPage() {
  const { integrationId } = Route.useParams()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [info, setInfo] = useState<IntegrationInfo | null>(null)

  const [running, setRunning] = useState<boolean>(false)
  const [result, setResult] = useState<unknown>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const apiFetch = useApiFetch()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await apiFetch("/api/integrations")
      const json = await readJson<IntegrationInfo[] | { error: string }>(res)
      if (!res.ok) {
        setLoadError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        setInfo((json as IntegrationInfo[]).find((i) => i.id === integrationId) ?? null)
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [apiFetch, integrationId])

  useEffect(() => {
    void load()
  }, [load])

  async function run(input: unknown) {
    setRunning(true)
    setRunError(null)
    setResult(null)
    try {
      const res = await apiFetch(`/api/integrations/${integrationId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      const json = await readJson<unknown>(res)
      if (!res.ok) {
        const message =
          typeof json === "object" && json !== null && "error" in json
            ? String((json as { error: unknown }).error)
            : `HTTP ${res.status}`
        setRunError(message)
      } else {
        setResult(json)
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">lade …</p>
  }

  if (loadError) {
    return <MnAlert label="Fehler">{loadError}</MnAlert>
  }

  if (!info) {
    return (
      <>
        <MnAlert label="Unbekannte Integration">„{integrationId}" ist nicht registriert.</MnAlert>
        <p className="mt-6">
          <BackLink />
        </p>
      </>
    )
  }

  return (
    <>
      <header className="mb-12">
        <span className="mn-mono">/sync/{info.id}</span>
        <h1 className="text-h-1 text-ink mt-4">{info.name}</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[540px]">{info.description}</p>
        <p className="mt-4">
          <BackLink />
        </p>
      </header>

      <section className="mb-12">
        <dl className="border-rule grid grid-cols-2 border md:grid-cols-4">
          <StatusStat label="Systeme" value={info.systems.join(" → ")} />
          <StatusStat label="Konfiguriert" value={info.configured ? "ja" : "nein"} />
          <StatusStat label="Cron aktiv" value={info.cronActive ? "ja" : "nein"} />
          <StatusStat
            label="Nächster Lauf"
            value={info.nextRun ? formatRunDate(info.nextRun) : "—"}
          />
        </dl>
      </section>

      {!info.configured ? (
        <MnAlert label="Nicht konfiguriert" className="mb-12">
          Fehlende Env-Variablen: {info.missingEnv.join(", ")}. Läufe sind erst möglich, wenn diese
          gesetzt sind.
        </MnAlert>
      ) : null}

      <section className="mb-16">
        <RunForm
          integrationId={info.id}
          running={running}
          disabled={!info.configured}
          onRun={run}
        />
        {info.running ? (
          <div className="mt-4">
            <MnStatusBadge>ein Lauf ist gerade aktiv</MnStatusBadge>
          </div>
        ) : null}
        {runError ? (
          <MnAlert label="Fehler" className="mt-6">
            {runError}
          </MnAlert>
        ) : null}
        {info.mappable ? (
          <div className="mt-6">
            <span className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">
              Erweitert
            </span>
            <div className="mt-1">
              <Link
                to="/sync/$integrationId/mapping"
                params={{ integrationId: info.id }}
                className="text-ink-2 hover:text-ink font-mono text-[0.75rem] tracking-[0.08em] underline underline-offset-4"
              >
                feld-zuordnung konfigurieren →
              </Link>
            </div>
          </div>
        ) : null}
      </section>

      {result != null ? <RunResultView integrationId={info.id} result={result} /> : null}
    </>
  )
}

function BackLink() {
  return (
    <Link
      to="/sync"
      className="text-ink-3 hover:text-ink font-mono text-[0.7rem] tracking-[0.18em] uppercase transition-colors"
    >
      ← alle integrationen
    </Link>
  )
}

function StatusStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-rule border-r border-b p-4 last:border-r-0 md:border-b-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd className="text-ink mt-1 font-mono text-base">{value}</dd>
    </div>
  )
}
