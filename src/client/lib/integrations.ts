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
