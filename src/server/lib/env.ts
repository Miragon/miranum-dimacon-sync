function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

/** Positive Zahl aus der Env; alles andere (leer, NaN, ≤0) fällt auf den Default. */
function positiveNumber(name: string, fallback: number): number {
  const raw = optional(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export type RateLimitedSystem = "dimacon" | "clockin" | "lexoffice"

export interface SystemTuning {
  /** Token-Bucket: nachfließende Requests pro Sekunde. */
  ratePerSec: number
  /** Token-Bucket: maximaler Vorrat (Sofort-Burst). */
  burst: number
  /** Parallele Requests je Lauf (p-limit) für dieses System. */
  concurrency: number
}

/**
 * Konservative Defaults — die echten Limits sind außer bei Lexware Office
 * (laut Doku 2 Requests/Sekunde) unbekannt. Lieber etwas zu langsam als eine
 * 429-Kaskade mit Wartezeiten im Minutenbereich; alles per Env übersteuerbar.
 */
const TUNING_DEFAULTS: Record<RateLimitedSystem, SystemTuning> = {
  dimacon: { ratePerSec: 10, burst: 20, concurrency: 8 },
  clockin: { ratePerSec: 5, burst: 10, concurrency: 5 },
  lexoffice: { ratePerSec: 2, burst: 2, concurrency: 2 },
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
    // Expliziter Opt-in ("on") für den Org-Sync (tenant-sync.ts) — zusätzlich
    // zum API-Key, damit Stage/Prod unabhängig schaltbar sind.
    orgSync: () => optional("WORKOS_ORG_SYNC") === "on",
  },
  /**
   * Planungshorizont des Archiv-Schutzes in Tagen (Default kommt aus der
   * Integration, damit die fachliche Begründung dort steht). Wie `tuning`
   * bei jedem Aufruf frisch gelesen.
   */
  // Untergrenze 1: ein Bruchwert wie "0.5" würde sonst still auf 0 gefloort
  // und schrumpfte den Archiv-Schutz auf den Lauftag zusammen.
  archiveHorizonDays: (fallback: number): number => {
    const days = Math.floor(positiveNumber("ARCHIVE_HORIZON_DAYS", fallback))
    return days >= 1 ? days : fallback
  },
  /**
   * Optionales Laufzeit-Tuning je Zielsystem (Token-Bucket + Parallelität).
   * Wird bei jedem Aufruf frisch gelesen — kein Neustart nötig, um ein
   * gedrosseltes System zu entlasten. Credentials bleiben ausdrücklich
   * außerhalb von env (verschlüsselt je Mandant in Postgres).
   */
  tuning: (system: RateLimitedSystem): SystemTuning => {
    const key = system.toUpperCase()
    const defaults = TUNING_DEFAULTS[system]
    return {
      ratePerSec: positiveNumber(`RATE_LIMIT_${key}_RPS`, defaults.ratePerSec),
      burst: positiveNumber(`RATE_LIMIT_${key}_BURST`, defaults.burst),
      concurrency: Math.floor(positiveNumber(`CONCURRENCY_${key}`, defaults.concurrency)),
    }
  },
}
