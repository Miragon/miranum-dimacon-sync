import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { RunForm } from "#/components/integrations/RunForm"
import { RunHistory } from "#/components/integrations/RunHistory"
import { RunResultView } from "#/components/integrations/RunResultView"
import { readJson, useApiFetch } from "#/lib/api"
import { formatRunDate } from "#/lib/integrations"
import type { IntegrationInfo } from "#/lib/integrations"
import { describeScope } from "#/lib/run-scope"

export const Route = createFileRoute("/sync/$integrationId")({ component: IntegrationDetailPage })

function IntegrationDetailPage() {
  const { integrationId } = Route.useParams()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [info, setInfo] = useState<IntegrationInfo | null>(null)

  const [running, setRunning] = useState<boolean>(false)
  const [result, setResult] = useState<unknown>(null)
  const [runError, setRunError] = useState<string | null>(null)
  // Zähler statt Reload-Callback: die Historie lädt nach jedem Lauf neu.
  const [runsVersion, setRunsVersion] = useState(0)
  const apiFetch = useApiFetch()
  // Das Ergebnis erscheint unter dem Formular — nach 30-120 s Wartezeit sieht
  // der Bildschirm sonst aus wie vorher, und der Nutzer klickt ein zweites Mal.
  const resultRef = useRef<HTMLDivElement>(null)

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
      // Immer neu laden, nicht nur bei res.ok: die Registry schreibt auch bei
      // einer Exception die Fehlerzeile in `sync_runs` und wirft weiter (500) —
      // ohne Bump stünde diese Zeile erst nach einem Reload in der Historie.
      setRunsVersion((v) => v + 1)
      // Nach dem Rendern scrollen, sonst existiert das Ziel noch nicht.
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: "start" }))
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
        <p className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <BackLink />
          {/* Die Seite zeigt Cron-Status, nächsten Lauf und Umfang an — alle
              drei werden in den Einstellungen gepflegt. Ohne diesen Link führt
              der Weg dorthin über die Übersichtstabelle zurück. */}
          <Link
            to="/sync/$integrationId/settings"
            params={{ integrationId: info.id }}
            search={{ tab: "zeitplan" }}
            className="text-ink-2 hover:text-ink font-mono text-[0.7rem] tracking-[0.18em] uppercase transition-colors"
          >
            einstellungen →
          </Link>
        </p>
      </header>

      <section className="mb-12">
        <dl className="border-rule grid grid-cols-2 border md:grid-cols-5">
          <StatusStat label="Systeme" value={info.systems.join(" → ")} />
          {/* Badges statt „ja/nein": dieselbe Sprache wie die Übersichtstabelle,
              und auf einen Blick scanbar. */}
          <StatusStat label="Konfiguriert">
            {info.configured ? (
              <MnStatusBadge variant="ok">ja</MnStatusBadge>
            ) : (
              <MnStatusBadge variant="warn">nein</MnStatusBadge>
            )}
          </StatusStat>
          <StatusStat label="Cron aktiv">
            {info.cronActive ? (
              <MnStatusBadge>aktiv</MnStatusBadge>
            ) : (
              <span className="text-ink-2 font-mono text-base">aus</span>
            )}
          </StatusStat>
          <StatusStat
            label="Nächster Lauf"
            value={info.nextRun ? formatRunDate(info.nextRun) : "—"}
          />
          {/* Umfang, mit dem geplante und body-lose Läufe fahren. */}
          <StatusStat label="Umfang" value={describeScope(info.id, info.runDefaults)} />
        </dl>
      </section>

      {!info.configured ? (
        <MnAlert label="Nicht konfiguriert" className="mb-12">
          Für diesen Mandanten fehlen Zugangsdaten: {info.missingCredentials.join(", ")}. Läufe sind
          erst möglich, wenn sie in den{" "}
          <Link
            to="/sync/$integrationId/settings"
            params={{ integrationId: info.id }}
            search={{ tab: "zugangsdaten" }}
            className="text-ink underline underline-offset-4"
          >
            Einstellungen
          </Link>{" "}
          hinterlegt sind.
        </MnAlert>
      ) : null}

      <section className="mb-16">
        <RunForm
          integrationId={info.id}
          running={running}
          disabled={!info.configured}
          onRun={run}
          defaults={info.runDefaults}
          integrationName={info.name}
          systems={info.systems}
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
      </section>

      <div ref={resultRef} aria-live="polite">
        {result != null ? <RunResultView integrationId={info.id} result={result} /> : null}
      </div>

      <RunHistory integrationId={info.id} refreshKey={runsVersion} />
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

function StatusStat({
  label,
  value,
  children,
}: {
  label: string
  value?: string
  children?: ReactNode
}) {
  return (
    <div className="border-rule border-r border-b p-4 last:border-r-0 md:border-b-0">
      <dt className="text-ink-3 font-mono text-[0.65rem] tracking-[0.18em] uppercase">{label}</dt>
      <dd className="text-ink mt-1 font-mono text-base">{children ?? value}</dd>
    </div>
  )
}
