import { getConfiguredSystems } from "../db/repos/credentials.js"
import { integrations } from "./registry.js"
import type { SystemId } from "./types.js"

interface SystemDefinition {
  id: SystemId
  name: string
}

/** Die angebundenen Systeme — Quelle für `GET /api/systems`. */
export const SYSTEMS: readonly SystemDefinition[] = [
  { id: "dimacon", name: "Dimacon" },
  { id: "clockin", name: "ClockIn" },
  { id: "lexoffice", name: "Lexware Office" },
]

export interface SystemStatus {
  id: SystemId
  name: string
  /** true = der Mandant hat Zugangsdaten für dieses System hinterlegt */
  configured: boolean
  /** IDs der Integrationen, die dieses System nutzen */
  integrations: string[]
}

export async function systemStatuses(tenantId: string): Promise<SystemStatus[]> {
  const configured = await getConfiguredSystems(tenantId)
  return SYSTEMS.map((system) => ({
    id: system.id,
    name: system.name,
    configured: configured.has(system.id),
    integrations: integrations.filter((i) => i.systems.includes(system.id)).map((i) => i.id),
  }))
}
