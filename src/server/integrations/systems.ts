import { integrations } from "./registry.js"
import type { SystemId } from "./types.js"

interface SystemDefinition {
  id: SystemId
  name: string
  requiredEnv: readonly string[]
}

/** Die angebundenen Systeme — Quelle für `GET /api/systems`. */
export const SYSTEMS: readonly SystemDefinition[] = [
  {
    id: "dimacon",
    name: "Dimacon",
    requiredEnv: ["DIMACON_BASE_URL", "DIMACON_TENANT", "DIMACON_API_TOKEN"],
  },
  {
    id: "clockin",
    name: "ClockIn",
    requiredEnv: ["CLOCKIN_API_TOKEN"],
  },
  {
    id: "lexoffice",
    name: "Lexware Office",
    requiredEnv: ["LEXWARE_OFFICE_API_KEY"],
  },
]

export interface SystemStatus {
  id: SystemId
  name: string
  configured: boolean
  missingEnv: string[]
  /** IDs der Integrationen, die dieses System nutzen */
  integrations: string[]
}

export function systemStatuses(): SystemStatus[] {
  return SYSTEMS.map((system) => {
    const missing = system.requiredEnv.filter((name) => {
      const value = process.env[name]
      return !value || value.length === 0
    })
    return {
      id: system.id,
      name: system.name,
      configured: missing.length === 0,
      missingEnv: missing,
      integrations: integrations.filter((i) => i.systems.includes(system.id)).map((i) => i.id),
    }
  })
}
