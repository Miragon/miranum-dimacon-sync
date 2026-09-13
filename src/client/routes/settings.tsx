import { Link, createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { CredentialCard } from "#/components/credentials/CredentialCard"
import { MnAlert } from "#/components/miranum/MnAlert"
import { readJson, useApiFetch } from "#/lib/api"
import { MnStatusBadge } from "#/components/miranum/MnStatusBadge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table"
import { CREDENTIAL_SYSTEMS, EMPTY_STATUS, type CredentialStatus } from "#/lib/credentials"
import type { IntegrationInfo } from "#/lib/integrations"
import { useTenant } from "#/lib/tenant"

export const Route = createFileRoute("/settings")({ component: SettingsPage })

/**
 * Zentrale Einstellungen: nur das gemeinsame Quellsystem Dimacon.
 * Alles Integrationsspezifische (Zeitplan, Clockin-/Lexware-Zugangsdaten,
 * Feld-Zuordnung) liegt auf der Einstellungsseite der jeweiligen Integration.
 */
function SettingsPage() {
  const apiFetch = useApiFetch()
  const tenantCtx = useTenant()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<CredentialStatus[]>([])
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [credRes, intRes] = await Promise.all([
        apiFetch("/api/credentials"),
        apiFetch("/api/integrations"),
      ])
      const creds = await readJson<CredentialStatus[] | { error: string }>(credRes)
      if (!credRes.ok) {
        setError("error" in creds ? (creds as { error: string }).error : `HTTP ${credRes.status}`)
        return
      }
      setStatuses(creds as CredentialStatus[])

      // Nur für die Wegweiser-Liste unten — ein Fehler hier darf die
      // Dimacon-Karte nicht blockieren.
      const infos = await readJson<IntegrationInfo[] | { error: string }>(intRes)
      if (intRes.ok) setIntegrations(infos as IntegrationInfo[])
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
        <span className="mn-mono">/settings · zentral</span>
        <h1 className="text-h-1 text-ink mt-4">Einstellungen</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[560px]">
          Dimacon ist das gemeinsame Quellsystem aller Integrationen
          {tenantCtx ? (
            <>
              {" "}
              des Mandanten <strong className="text-ink">{tenantCtx.tenant.name}</strong>
            </>
          ) : null}
          . Tokens werden verschlüsselt gespeichert und nie wieder angezeigt. Die Zugangsdaten der
          Zielsysteme liegen bei der jeweiligen Integration — verlinkt unten.
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
        <section>
          <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
            Dimacon-Zugangsdaten
          </h2>
          <CredentialCard
            system={dimacon}
            status={statuses.find((s) => s.system === "dimacon") ?? EMPTY_STATUS.dimacon}
            onSaved={(updated) =>
              setStatuses((prev) => {
                const rest = prev.filter((s) => s.system !== updated.system)
                return [...rest, updated]
              })
            }
          />

          {/* Wegweiser statt Prosa: „Einstellungen" ist der Ort, an dem ein
              Mensch Zugangsdaten sucht. Vorher stand hier nur ein Satz, der
              das Zahnrad in der Übersichtstabelle BESCHRIEB — die Gegenrichtung
              (von der Integration hierher) existierte längst. */}
          {integrations.length > 0 ? (
            <section className="mt-16">
              <h2 className="text-ink mb-4 font-mono text-[0.75rem] tracking-[0.18em] uppercase">
                Zugangsdaten der Zielsysteme
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Integration</TableHead>
                    <TableHead className="w-56">Zielsystem</TableHead>
                    <TableHead className="w-48">Status</TableHead>
                    <TableHead className="w-44" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {integrations.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.name}</TableCell>
                      <TableCell className="font-mono text-[0.8rem]">
                        {i.systems.filter((sys) => sys !== "dimacon").join(", ") || "—"}
                      </TableCell>
                      <TableCell>
                        {i.configured ? (
                          <MnStatusBadge variant="ok">hinterlegt</MnStatusBadge>
                        ) : (
                          <MnStatusBadge variant="warn">fehlt</MnStatusBadge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Link
                          to="/sync/$integrationId/settings"
                          params={{ integrationId: i.id }}
                          search={{ tab: "zugangsdaten" }}
                          className="text-ink hover:text-ink-2 font-mono text-[0.75rem] tracking-[0.12em] uppercase underline underline-offset-4"
                        >
                          bearbeiten →
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ) : null}
        </section>
      )}
    </>
  )
}
