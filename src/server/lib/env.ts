function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export const env = {
  port: Number(process.env.PORT ?? 3020),
  clockin: {
    apiToken: () => required("CLOCKIN_API_TOKEN"),
    baseUrl: () => optional("CLOCKIN_BASE_URL"),
  },
  dimacon: {
    apiToken: () => required("DIMACON_API_TOKEN"),
    baseUrl: () => required("DIMACON_BASE_URL"),
    tenant: () => required("DIMACON_TENANT"),
  },
  lexoffice: {
    apiKey: () => required("LEXWARE_OFFICE_API_KEY"),
    baseUrl: () => optional("LEXWARE_OFFICE_BASE_URL"),
  },
  sync: {
    webhookSecret: () => optional("SYNC_WEBHOOK_SECRET"),
  },
  workos: {
    clientId: () => optional("WORKOS_CLIENT_ID"),
    requiredOrgId: () => optional("WORKOS_REQUIRED_ORG_ID"),
  },
}
