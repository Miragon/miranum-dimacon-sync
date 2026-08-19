import { createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { CredentialCard } from "#/components/credentials/CredentialCard"
import { MnAlert } from "#/components/miranum/MnAlert"
import { readJson, useApiFetch } from "#/lib/api"
import { CREDENTIAL_SYSTEMS, EMPTY_STATUS, type CredentialStatus } from "#/lib/credentials"
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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const credRes = await apiFetch("/api/credentials")
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
          . Tokens werden verschlüsselt gespeichert und nie wieder angezeigt.
          Integrations-Einstellungen (Zeitplan, Zugangsdaten des Zielsystems, Feld-Zuordnung)
          erreichst du über das Zahnrad in der Integrations-Übersicht.
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
        </section>
      )}
    </>
  )
}
