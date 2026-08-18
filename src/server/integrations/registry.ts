import { dimaconClockinIntegration } from "./dimacon-clockin/index.js"
import { dimaconLexofficeIntegration } from "./dimacon-lexoffice/index.js"
import { runExclusive } from "./mutex.js"
import type { IntegrationDefinition } from "./types.js"

/** Alle verfügbaren Integrationen — eine pro Zielsystem. */
export const integrations: readonly IntegrationDefinition[] = [
  dimaconClockinIntegration,
  dimaconLexofficeIntegration,
]

export function getIntegration(id: string): IntegrationDefinition | undefined {
  return integrations.find((i) => i.id === id)
}

/**
 * Zentraler Einstiegspunkt für Läufe (Routes + Scheduler): pro Integration
 * läuft maximal ein Run gleichzeitig, sonst SyncBusyError.
 */
export async function runIntegration(def: IntegrationDefinition, input: unknown): Promise<unknown> {
  return runExclusive(def.id, () => def.run(input))
}
