import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { CredentialCard } from "#/components/credentials/CredentialCard"
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
import { CREDENTIAL_SYSTEMS, EMPTY_STATUS, type CredentialStatus } from "#/lib/credentials"
import { findElementBySystem } from "#/lib/elements"
import { useTenant } from "#/lib/tenant"

export const Route = createFileRoute("/modules")({ component: Modules })

interface SystemStatus {
  id: string
  name: string
  configured: boolean
  integrations: string[]
}

/**
 * Die vier angebundenen Systeme — Status UND Zugangsdaten an einem Ort.
 *
 * Die frühere Seite /settings beantwortete mit „wo hinterlege ich
 * Zugangsdaten?" genau die Frage, für die es hier schon eine Statusspalte
 * gab, und belegte dafür einen eigenen Nav-Eintrag direkt neben „Systeme".
 * Dimacon (gemeinsames Quellsystem) wird jetzt hier gepflegt; die
 * Zugangsdaten der Zielsysteme bleiben bei ihrer Integration, weil dort auch
 * Zeitplan, Umfang und Feld-Zuordnung liegen — von hier aus verlinkt.
 */
function Modules() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [systems, setSystems] = useState<SystemStatus[]>([])
  // null = noch nicht (erfolgreich) geladen. Bewusst kein leeres Array als
  // Startwert: die Dimacon-Karte würde sonst bei einem Fehler des
  // Credential-Endpunkts „nicht konfiguriert" behaupten.
  const [statuses, setStatuses] = useState<CredentialStatus[] | null>(null)
  const apiFetch = useApiFetch()
  const tenantCtx = useTenant()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sysRes, credRes] = await Promise.all([
        apiFetch("/api/systems"),
        apiFetch("/api/credentials"),
      ])

      const sys = await readJson<SystemStatus[] | { error: string }>(sysRes)
      if (!sysRes.ok) {
        setError("error" in sys ? sys.error : `HTTP ${sysRes.status}`)
        return
      }
      setSystems(sys as SystemStatus[])

      const creds = await readJson<CredentialStatus[] | { error: string }>(credRes)
      if (!credRes.ok) {
        setError("error" in creds ? (creds as { error: string }).error : `HTTP ${credRes.status}`)
        return
      }
      setStatuses(creds as CredentialStatus[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    void load()
  }, [load])

  const dimacon = CREDENTIAL_SYSTEMS.find((s) => s.id === "dimacon")!

  return (
    <>
      <header className="mb-12">
        <span className="mn-mono">/modules · systeme</span>
        <h1 className="text-h-1 text-ink mt-4">Systeme</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[560px]">
          Die vier angebundenen Systeme
          {tenantCtx ? (
            <>
              {" "}
              des Mandanten <strong className="text-ink">{tenantCtx.tenant.name}</strong>
            </>
          ) : null}{" "}
          mit ihrem Konfigurations-Status. Dimacon ist das gemeinsame Quellsystem und wird hier
          gepflegt, die Zugangsdaten der Zielsysteme liegen bei ihrer Integration. Die Sync-Abläufe
          dazwischen laufen unter{" "}
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
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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
                  <TableHead className="w-44">Status</TableHead>
                  <TableHead className="w-44" />
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
                          <MnStatusBadge variant="warn">zugangsdaten fehlen</MnStatusBadge>
                        )}
                      </TableCell>
                      {/* Der Weg zu den Zugangsdaten hängt am System, nicht am
                          Status: vorher erschien er nur im Fehlerfall, ein
                          hinterlegtes Token war von hier aus nicht änderbar. */}
                      <TableCell>
                        {s.id === "dimacon" ? (
                          <a
                            href="#dimacon-zugangsdaten"
                            className="text-ink hover:text-ink-2 font-mono text-[0.75rem] tracking-[0.12em] uppercase underline underline-offset-4"
                          >
                            bearbeiten →
                          </a>
                        ) : s.integrations.length > 0 ? (
                          <Link
                            to="/sync/$integrationId/settings"
                            params={{ integrationId: s.integrations[0] }}
                            // Ohne den Tab landet der einzige Weg zu den
                            // Zugangsdaten auf dem Zeitplan-Editor.
                            search={{ tab: "zugangsdaten" }}
                            className="text-ink hover:text-ink-2 font-mono text-[0.75rem] tracking-[0.12em] uppercase underline underline-offset-4"
                          >
                            bearbeiten →
                          </Link>
                        ) : (
                          <span className="text-ink-3 font-mono text-[0.75rem]">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </section>

          {statuses ? (
            <section id="dimacon-zugangsdaten" className="mt-16 scroll-mt-24">
              <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
                Dimacon-Zugangsdaten
              </h2>
              <p className="text-body-sm text-ink-2 mb-6 max-w-[560px]">
                Dimacon ist das gemeinsame Quellsystem aller Integrationen. Das Token wird
                verschlüsselt gespeichert und nie wieder angezeigt — leer lassen heißt: bestehendes
                Token behalten.
              </p>
              <CredentialCard
                system={dimacon}
                status={statuses.find((s) => s.system === "dimacon") ?? EMPTY_STATUS.dimacon}
                onSaved={(updated) => {
                  setStatuses((prev) => [
                    ...(prev ?? []).filter((s) => s.system !== updated.system),
                    updated,
                  ])
                  // Die Statusspalte oben kommt aus /api/systems und wüsste
                  // sonst bis zum nächsten Reload nichts vom neuen Token.
                  setSystems((prev) =>
                    prev.map((s) =>
                      s.id === updated.system ? { ...s, configured: updated.configured } : s,
                    ),
                  )
                }}
              />
            </section>
          ) : null}
        </>
      )}
    </>
  )
}
