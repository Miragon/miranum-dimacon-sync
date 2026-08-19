import type { z } from "zod"
import { getConfiguredSystems } from "../db/repos/credentials.js"
import type { RunTrigger } from "../db/repos/sync-runs.js"
import type { TenantClients } from "../lib/clients.js"
import type { Logger } from "../lib/log.js"
import type { EntityFieldMapping, MappingEntity } from "./shared/field-mapping-schema.js"

export type SystemId = "dimacon" | "clockin" | "lexoffice"

/**
 * Tenant-Kontext eines Laufs — von buildRunContext (context.ts) verdrahtet.
 * run() erhält Clients + Feld-Zuordnungs-Zugriff bereits auf den Mandanten
 * gescoped; Integrations-Code kennt keine DB und keine Env-Vars.
 */
export interface IntegrationRunContext {
  tenantId: string
  trigger: RunTrigger
  clients: TenantClients
  getFieldMapping(entity: MappingEntity): Promise<EntityFieldMapping | undefined>
  log: Logger
}

/**
 * Eine Integration ist ein in sich geschlossener Ablauf zwischen zwei (oder
 * mehr) der angebundenen Systeme. Jede Integration wird in `registry.ts`
 * registriert und bekommt damit automatisch: eigenen Mutex je Mandant
 * (mutex.ts), eigene Cron-Slots je Mandant (scheduler.ts + schedule_settings)
 * und eigene HTTP-Routen (`/api/integrations/:id/...`).
 */
export interface IntegrationDefinition {
  /** Stabiler Key — URL-Segment und Settings-Key, z. B. "dimacon-clockin" */
  id: string
  name: string
  description: string
  systems: readonly SystemId[]
  /** Systeme, deren Mandanten-Credentials run() zwingend braucht */
  requiredCredentials: readonly SystemId[]
  /** Zod-Schema für den Run-Input; muss `{}` akzeptieren (Scheduler-Läufe) */
  inputSchema: z.ZodTypeAny
  run(ctx: IntegrationRunContext, input: unknown): Promise<unknown>
}

/** Typsichere Brücke: bindet run() an den Output des inputSchema. */
export function defineIntegration<S extends z.ZodTypeAny>(def: {
  id: string
  name: string
  description: string
  systems: readonly SystemId[]
  requiredCredentials: readonly SystemId[]
  inputSchema: S
  run(ctx: IntegrationRunContext, input: z.output<S>): Promise<unknown>
}): IntegrationDefinition {
  return def
}

/** Fehlende Credential-Systeme des Mandanten (ersetzt das alte missingEnv). */
export async function missingCredentials(
  def: IntegrationDefinition,
  tenantId: string,
): Promise<SystemId[]> {
  const configured = await getConfiguredSystems(tenantId)
  return def.requiredCredentials.filter((system) => !configured.has(system))
}

export async function isConfigured(def: IntegrationDefinition, tenantId: string): Promise<boolean> {
  return (await missingCredentials(def, tenantId)).length === 0
}
