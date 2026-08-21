function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

/**
 * Laufzeit-Konfiguration. Die Integrations-Credentials (DIMACON_*,
 * CLOCKIN_*, LEXWARE_OFFICE_*) sind KEINE Laufzeit-Env mehr — sie liegen
 * verschlüsselt je Mandant in Postgres (tenant_credentials) und werden nur
 * noch vom einmaligen Legacy-Seed (db/seed-legacy.ts) direkt aus process.env
 * gelesen. Gleiches gilt für WORKOS_REQUIRED_ORG_ID, SYNC_WEBHOOK_SECRET und
 * SYNC_CRON/SYNC_TZ (Seed-Input).
 */
export const env = {
  port: Number(process.env.PORT ?? 3020),
  database: {
    url: () => required("DATABASE_URL"),
  },
  workos: {
    clientId: () => optional("WORKOS_CLIENT_ID"),
    // Server-only (nie VITE_*): filtert die Switcher-Liste nach Org-Mitgliedschaft.
    apiKey: () => optional("WORKOS_API_KEY"),
  },
}
