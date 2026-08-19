export type CredentialSystemId = "dimacon" | "clockin" | "lexoffice"

export interface CredentialStatus {
  system: CredentialSystemId
  configured: boolean
  updatedAt: string | null
  keyVersion: string | null
  config: Record<string, string>
}

export interface ConfigFieldDef {
  key: string
  label: string
  placeholder: string
  required: boolean
}

export interface SystemDef {
  id: CredentialSystemId
  name: string
  tokenLabel: string
  /** Bestehender Probe-Endpoint — testet die GESPEICHERTEN Zugangsdaten. */
  probePath: string
  fields: ConfigFieldDef[]
}

export const CREDENTIAL_SYSTEMS: SystemDef[] = [
  {
    id: "dimacon",
    name: "Dimacon",
    tokenLabel: "API-Token",
    probePath: "/api/dimacon/me",
    fields: [
      { key: "baseUrl", label: "Base-URL", placeholder: "https://…", required: true },
      { key: "tenant", label: "Dimacon-Mandant", placeholder: "z. B. miragon", required: true },
    ],
  },
  {
    id: "clockin",
    name: "ClockIn",
    tokenLabel: "API-Token",
    probePath: "/api/clockin/projects",
    fields: [
      { key: "baseUrl", label: "Base-URL (optional)", placeholder: "https://…", required: false },
    ],
  },
  {
    id: "lexoffice",
    name: "Lexware Office",
    tokenLabel: "API-Key",
    probePath: "/api/lexoffice/profile",
    fields: [
      { key: "baseUrl", label: "Base-URL (optional)", placeholder: "https://…", required: false },
    ],
  },
]

// Stabile Fallback-Objekte (Modul-Ebene): ein inline erzeugtes Fallback
// bekäme bei jedem Parent-Render eine neue Identität und würde über den
// [status]-Effect der CredentialCard ungespeicherte Eingaben löschen.
export const EMPTY_STATUS: Record<string, CredentialStatus> = Object.fromEntries(
  CREDENTIAL_SYSTEMS.map((s) => [
    s.id,
    { system: s.id, configured: false, updatedAt: null, keyVersion: null, config: {} },
  ]),
)
