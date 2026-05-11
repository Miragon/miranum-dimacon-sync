const rawClientId = import.meta.env.VITE_WORKOS_CLIENT_ID

export const WORKOS_CLIENT_ID: string | undefined =
  typeof rawClientId === "string" && rawClientId.length > 0 ? rawClientId : undefined

export const AUTH_ENABLED = Boolean(WORKOS_CLIENT_ID)
