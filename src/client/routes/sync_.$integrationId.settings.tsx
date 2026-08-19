import { createFileRoute, Link } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { CredentialCard } from "#/components/credentials/CredentialCard"
import { ScheduleCard, type ScheduleEntry } from "#/components/integrations/ScheduleCard"
import { MappingPanel } from "#/components/mapping/MappingPanel"
import { MnAlert } from "#/components/miranum/MnAlert"
import { readJson, useApiFetch } from "#/lib/api"
import { CREDENTIAL_SYSTEMS, EMPTY_STATUS, type CredentialStatus } from "#/lib/credentials"
import type { IntegrationInfo } from "#/lib/integrations"

export type SettingsTab = "zeitplan" | "zugangsdaten" | "mapping"

const TAB_LABELS: Record<SettingsTab, string> = {
  zeitplan: "Zeitplan",
  zugangsdaten: "Zugangsdaten",
  mapping: "Feld-Zuordnung",
}

export const Route = createFileRoute("/sync_/$integrationId/settings")({
  // Tab lebt in der URL (?tab=…) — Reload/Deep-Link behalten die Auswahl.
  // Optional getypt, damit Links ohne search-Prop gültig bleiben; das
  // Default (zeitplan) zieht die Komponente.
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab:
      search.tab === "zugangsdaten" || search.tab === "mapping" || search.tab === "zeitplan"
        ? (search.tab as SettingsTab)
        : undefined,
  }),
  component: IntegrationSettingsPage,
})

/**
 * Einstellungen EINER Integration, erreichbar über das Zahnrad in der
 * /sync-Übersicht: Tabs für Zeitplan, integrationsspezifische Zugangsdaten
 * (ohne Dimacon — das gemeinsame Quellsystem liegt zentral unter /settings)
 * und die eingebettete Feld-Zuordnung.
 */
function IntegrationSettingsPage() {
  const { integrationId } = Route.useParams()
  const { tab } = Route.useSearch()
  const apiFetch = useApiFetch()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<IntegrationInfo | null>(null)
  const [schedule, setSchedule] = useState<ScheduleEntry | null>(null)
  const [statuses, setStatuses] = useState<CredentialStatus[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [infoRes, scheduleRes, credRes] = await Promise.all([
        apiFetch("/api/integrations"),
        apiFetch("/api/settings/integrations"),
        apiFetch("/api/credentials"),
      ])

      const infos = await readJson<IntegrationInfo[] | { error: string }>(infoRes)
      if (!infoRes.ok) {
        setError("error" in infos ? (infos as { error: string }).error : `HTTP ${infoRes.status}`)
        return
      }
      setInfo((infos as IntegrationInfo[]).find((i) => i.id === integrationId) ?? null)

      const schedules = await readJson<ScheduleEntry[] | { error: string }>(scheduleRes)
      if (scheduleRes.ok) {
        setSchedule((schedules as ScheduleEntry[]).find((s) => s.id === integrationId) ?? null)
      }

      const creds = await readJson<CredentialStatus[] | { error: string }>(credRes)
      if (credRes.ok) {
        setStatuses(creds as CredentialStatus[])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [apiFetch, integrationId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">lade …</p>
  }

  if (error) {
    return <MnAlert label="Fehler">{error}</MnAlert>
  }

  if (!info) {
    return (
      <>
        <MnAlert label="Unbekannte Integration">„{integrationId}" ist nicht registriert.</MnAlert>
        <p className="mt-6">
          <Link
            to="/sync"
            className="text-ink-3 hover:text-ink font-mono text-[0.7rem] tracking-[0.18em] uppercase transition-colors"
          >
            ← alle integrationen
          </Link>
        </p>
      </>
    )
  }

  // Integrationsspezifische Systeme — Dimacon wird zentral gepflegt.
  const systems = CREDENTIAL_SYSTEMS.filter(
    (s) => s.id !== "dimacon" && info.systems.includes(s.id),
  )

  const tabs: SettingsTab[] = info.mappable
    ? ["zeitplan", "zugangsdaten", "mapping"]
    : ["zeitplan", "zugangsdaten"]
  // mapping-Tab per URL bei nicht-mappbarer Integration → auf Zeitplan zurück.
  const activeTab: SettingsTab = tab && tabs.includes(tab) ? tab : "zeitplan"

  return (
    <>
      <header className="mb-10">
        <span className="mn-mono">/sync/{info.id}/settings · einstellungen</span>
        <h1 className="text-h-1 text-ink mt-4">Einstellungen</h1>
        <p className="text-body text-ink-2 mt-3 max-w-[540px]">
          Zeitplan, Zugangsdaten und Feld-Zuordnung für{" "}
          <strong className="text-ink">{info.name}</strong>.
        </p>
        <p className="mt-4">
          <Link
            to="/sync/$integrationId"
            params={{ integrationId: info.id }}
            className="text-ink-3 hover:text-ink font-mono text-[0.7rem] tracking-[0.18em] uppercase transition-colors"
          >
            ← zurück zur integration
          </Link>
        </p>
      </header>

      <nav
        className="border-rule mb-10 flex flex-wrap gap-3 border-b pb-4"
        aria-label="Einstellungs-Tabs"
      >
        {tabs.map((t) => (
          <Link
            key={t}
            to="/sync/$integrationId/settings"
            params={{ integrationId: info.id }}
            search={{ tab: t }}
            replace
            className={`border px-4 py-2 font-mono text-[0.75rem] tracking-[0.14em] uppercase transition-colors ${
              t === activeTab
                ? "border-ink text-ink"
                : "border-rule text-ink-2 hover:border-ink hover:text-ink"
            }`}
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      {activeTab === "zeitplan" ? (
        schedule ? (
          <ScheduleCard entry={schedule} onSaved={setSchedule} />
        ) : (
          <p className="text-ink-3 font-mono text-xs tracking-[0.18em] uppercase">
            zeitplan konnte nicht geladen werden
          </p>
        )
      ) : null}

      {activeTab === "zugangsdaten" ? (
        <>
          <div className="space-y-16">
            {systems.map((system) => (
              <CredentialCard
                key={system.id}
                system={system}
                status={statuses.find((s) => s.system === system.id) ?? EMPTY_STATUS[system.id]}
                onSaved={(updated) =>
                  setStatuses((prev) => {
                    const rest = prev.filter((s) => s.system !== updated.system)
                    return [...rest, updated]
                  })
                }
              />
            ))}
          </div>
          <p className="text-ink-3 mt-6 font-mono text-[0.7rem]">
            Dimacon-Zugangsdaten werden zentral gepflegt —{" "}
            <Link to="/settings" className="text-ink-2 hover:text-ink underline underline-offset-4">
              einstellungen →
            </Link>
          </p>
        </>
      ) : null}

      {activeTab === "mapping" ? <MappingPanel integrationId={info.id} /> : null}
    </>
  )
}
