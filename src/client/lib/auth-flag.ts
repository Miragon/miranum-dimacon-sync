function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const WORKOS_CLIENT_ID = readString(import.meta.env.VITE_WORKOS_CLIENT_ID)
export const WORKOS_API_HOSTNAME = readString(import.meta.env.VITE_WORKOS_API_HOSTNAME)

export const AUTH_ENABLED = Boolean(WORKOS_CLIENT_ID)
