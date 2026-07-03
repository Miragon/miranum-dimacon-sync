export interface IntegrationInfo {
  id: string
  name: string
  description: string
  systems: string[]
  configured: boolean
  missingEnv: string[]
  running: boolean
  cronActive: boolean
  nextRun: string | null
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
