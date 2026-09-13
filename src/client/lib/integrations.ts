export interface IntegrationInfo {
  id: string
  name: string
  description: string
  systems: string[]
  configured: boolean
  /** System-IDs, für die der Mandant noch keine Zugangsdaten hinterlegt hat */
  missingCredentials: string[]
  running: boolean
  cronActive: boolean
  nextRun: string | null
  /** true = Feld-Zuordnungs-Tab in den Integrations-Einstellungen verfügbar */
  mappable?: boolean
  /** Gespeicherter Run-Umfang (leer = Schema-Defaults) — belegt Formulare vor */
  runDefaults?: Record<string, unknown>
}

/** Zeile der Run-Historie (`GET /api/integrations/:id/runs`). */
export interface RunHistoryEntry {
  id: string
  trigger: "manual" | "cron" | "webhook" | "mcp"
  /** "skipped" = nie gestartet (Cron fail-closed) — dryRun/input sind Platzhalter */
  status: "running" | "success" | "error" | "skipped"
  dryRun: boolean
  /** Effektiver Input des Laufs — Grundlage der Umfang-Spalte */
  input: Record<string, unknown> | null
  error: string | null
  startedAt: string
  durationMs: number | null
}

export function formatRunDate(iso: string, tz = "Europe/Berlin"): string {
  try {
    return new Intl.DateTimeFormat("de-DE", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso))
  } catch {
    return iso
  }
}
