import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { ElementBox } from "#/components/miranum/ElementBox"
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
import { readJson, useApiFetch } from "#/lib/api"
import { findElementBySystem } from "#/lib/elements"

export const Route = createFileRoute("/modules")({ component: Modules })

interface SystemStatus {
  id: string
  name: string
  configured: boolean
  missingEnv: string[]
  integrations: string[]
}

function Modules() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [systems, setSystems] = useState<SystemStatus[]>([])
  const apiFetch = useApiFetch()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch("/api/systems")
      const json = await readJson<SystemStatus[] | { error: string }>(res)
      if (!res.ok) {
        setError("error" in json ? json.error : `HTTP ${res.status}`)
      } else {
        setSystems(json as SystemStatus[])
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
        <span className="mn-mono">/modules · systeme</span>
        <h1 className="text-h-1 text-ink mt-4">Module</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[540px]">
          Die drei angebundenen Systeme dieser Installation. Der Status kommt aus der
          Server-Konfiguration — die Sync-Abläufe dazwischen laufen unter{" "}
          <Link to="/sync" className="text-ink underline underline-offset-4">
            Integrationen
          </Link>
          .
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
        <>
          <section className="mb-16">
            <h2 className="text-ink mb-6 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
              Übersicht
            </h2>
            <div className="grid gap-4 md:grid-cols-3">
              {systems.map((s) => {
                const el = findElementBySystem(s.id)
                return (
                  <div key={s.id} className="flex items-center gap-5">
                    {el ? (
                      <ElementBox
                        no={el.no}
                        symbol={el.symbol}
                        name={el.name}
                        ig={el.ig}
                        group={el.group}
                        size="sm"
                      />
                    ) : null}
                    <div>
                      <h3 className="text-h-4 text-ink">{s.name}</h3>
                      {el?.description ? (
                        <p className="text-body-sm mt-0.5">{el.description}</p>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section>
            <h2 className="text-ink mb-6 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
              Status
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">No.</TableHead>
                  <TableHead className="w-20">Symbol</TableHead>
                  <TableHead>System</TableHead>
                  <TableHead>Integrationen</TableHead>
                  <TableHead className="w-40">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {systems.map((s) => {
                  const el = findElementBySystem(s.id)
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <span className="mn-mono">{el?.no ?? "—"}</span>
                      </TableCell>
                      <TableCell className="font-semibold">{el?.symbol ?? "—"}</TableCell>
                      <TableCell>{s.name}</TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-3">
                          {s.integrations.map((id) => (
                            <Link
                              key={id}
                              to="/sync/$integrationId"
                              params={{ integrationId: id }}
                              className="text-ink-2 hover:text-ink font-mono text-[0.75rem] underline underline-offset-4"
                            >
                              {id}
                            </Link>
                          ))}
                        </span>
                      </TableCell>
                      <TableCell>
                        {s.configured ? (
                          <MnStatusBadge variant="ok">konfiguriert</MnStatusBadge>
                        ) : (
                          <span className="flex flex-col items-start gap-1">
                            <MnStatusBadge variant="warn">env fehlt</MnStatusBadge>
                            <span className="text-ink-3 font-mono text-[0.65rem]">
                              {s.missingEnv.join(", ")}
                            </span>
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </section>
        </>
      )}
    </>
  )
}
