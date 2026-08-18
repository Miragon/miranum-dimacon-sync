import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { MnAlert } from "#/components/miranum/MnAlert"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import { readJson, useApiFetch } from "#/lib/api"
import { formatRunDate } from "#/lib/integrations"
import type { IntegrationInfo } from "#/lib/integrations"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table"

export const Route = createFileRoute("/sync/")({ component: IntegrationsPage })

function IntegrationsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<IntegrationInfo[]>([])
  const apiFetch = useApiFetch()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch("/api/integrations")
      const json = await readJson<IntegrationInfo[] | { error: string }>(res)
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        setItems(json as IntegrationInfo[])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <header className="mb-12">
        <span className="mn-mono">/sync · integrationen</span>
        <h1 className="text-h-1 text-ink mt-4">Integrationen</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[540px]">
          Alle Sync-Abläufe zwischen Dimacon, Clockin und Lexware Office — Status einsehen, manuell
          starten, Zeitpläne unter Settings konfigurieren.
        </p>
      </header>

      {error ? (
        <MnAlert label="Fehler" className="mb-8">
          {error}
        </MnAlert>
      ) : null}

      {loading ? (
        <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">lade …</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Integration</TableHead>
              <TableHead className="w-56">Systeme</TableHead>
              <TableHead className="w-56">Status</TableHead>
              <TableHead className="w-48">Nächster Lauf</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <TableRow key={i.id}>
                <TableCell>
                  <div className="font-medium">{i.name}</div>
                  <div className="text-ink-2 mt-1 max-w-[420px] text-[0.8rem]">{i.description}</div>
                </TableCell>
                <TableCell className="font-mono text-[0.8rem]">{i.systems.join(" → ")}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {i.configured ? (
                      <MnStatusBadge variant="ok">konfiguriert</MnStatusBadge>
                    ) : (
                      <MnStatusBadge variant="warn">env fehlt</MnStatusBadge>
                    )}
                    {i.cronActive ? <MnStatusBadge>cron aktiv</MnStatusBadge> : null}
                    {i.running ? <MnStatusBadge>läuft</MnStatusBadge> : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-[0.8rem]">
                  {i.nextRun ? formatRunDate(i.nextRun) : "—"}
                </TableCell>
                <TableCell>
                  <Link
                    to="/sync/$integrationId"
                    params={{ integrationId: i.id }}
                    className="text-ink hover:text-ink-2 font-mono text-[0.75rem] tracking-[0.12em] uppercase underline underline-offset-4"
                  >
                    öffnen
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}
