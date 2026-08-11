import type { z } from "zod"

export type SystemId = "dimacon" | "clockin" | "lexoffice"

/**
 * Eine Integration ist ein in sich geschlossener Ablauf zwischen zwei (oder
 * mehr) der angebundenen Systeme. Jede Integration wird in `registry.ts`
 * registriert und bekommt damit automatisch: eigenen Mutex (mutex.ts),
 * eigenen Cron-Slot (scheduler.ts + Settings-Key) und eigene HTTP-Routen
 * (`/api/integrations/:id/...`).
 */
export interface IntegrationDefinition {
  /** Stabiler Key — URL-Segment und Settings-Key, z. B. "dimacon-clockin" */
  id: string
  name: string
  description: string
  systems: readonly SystemId[]
  /** Env-Variablen, ohne die run() nicht lauffähig ist */
  requiredEnv: readonly string[]
  /** Zod-Schema für den Run-Input; muss `{}` akzeptieren (Scheduler-Läufe) */
  inputSchema: z.ZodTypeAny
  run(input: unknown): Promise<unknown>
}

/** Typsichere Brücke: bindet run() an den Output des inputSchema. */
export function defineIntegration<S extends z.ZodTypeAny>(def: {
  id: string
  name: string
  description: string
  systems: readonly SystemId[]
  requiredEnv: readonly string[]
  inputSchema: S
  run(input: z.output<S>): Promise<unknown>
}): IntegrationDefinition {
  return def
}

export function missingEnv(def: IntegrationDefinition): string[] {
  return def.requiredEnv.filter((name) => {
    const value = process.env[name]
    return !value || value.length === 0
  })
}

export function isConfigured(def: IntegrationDefinition): boolean {
  return missingEnv(def).length === 0
}
