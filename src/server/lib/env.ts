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
 * Base-URLs früh prüfen: `new URL("localhost:8080")` wirft *nicht*, sondern
 * liefert das Schema "localhost:" — der Fehler taucht sonst erst tief im Sync
 * als undici-"fetch failed (unknown scheme)" auf.
 */
function assertHttpUrl(name: string, value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Invalid ${name}: ${JSON.stringify(value)} is not a valid URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid ${name}: ${JSON.stringify(value)} must start with http:// or https:// ` +
        `(parsed scheme: "${parsed.protocol}")`,
    )
  }
  return value
}

function requiredUrl(name: string): string {
  return assertHttpUrl(name, required(name))
}

function optionalUrl(name: string): string | undefined {
  const value = optional(name)
  return value === undefined ? undefined : assertHttpUrl(name, value)
}

export const env = {
  port: Number(process.env.PORT ?? 3020),
  clockin: {
    apiToken: () => required("CLOCKIN_API_TOKEN"),
    baseUrl: () => optionalUrl("CLOCKIN_BASE_URL"),
  },
  dimacon: {
    apiToken: () => required("DIMACON_API_TOKEN"),
    baseUrl: () => requiredUrl("DIMACON_BASE_URL"),
    tenant: () => required("DIMACON_TENANT"),
  },
  lexoffice: {
    apiKey: () => required("LEXWARE_OFFICE_API_KEY"),
    baseUrl: () => optionalUrl("LEXWARE_OFFICE_BASE_URL"),
  },
  sync: {
    webhookSecret: () => optional("SYNC_WEBHOOK_SECRET"),
  },
  workos: {
    clientId: () => optional("WORKOS_CLIENT_ID"),
    requiredOrgId: () => optional("WORKOS_REQUIRED_ORG_ID"),
  },
}
