const rawClientId = import.meta.env.VITE_WORKOS_CLIENT_ID

export const WORKOS_CLIENT_ID: string | undefined =
  typeof rawClientId === "string" && rawClientId.length > 0 ? rawClientId : undefined

export const AUTH_ENABLED = Boolean(WORKOS_CLIENT_ID)

const rawApiHostname = import.meta.env.VITE_WORKOS_API_HOSTNAME

/**
 * Optionale AuthKit-Custom-Domain (z. B. `auth.example.com`). Gesetzt =
 * Session- und Refresh-Cookie werden First-Party, der Refresh trägt über
 * Page-Loads hinweg. Leer = heutiges Verhalten (api.workos.com, Cross-Site-
 * Cookie: jeder Reload läuft still über die Hosted-Login-Seite und der
 * Refresh ist in Safari/mit blockierten Third-Party-Cookies fragil).
 */
export const WORKOS_API_HOSTNAME: string | undefined =
  typeof rawApiHostname === "string" && rawApiHostname.length > 0 ? rawApiHostname : undefined
