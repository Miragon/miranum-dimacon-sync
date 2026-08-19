import { getFieldMapping } from "../db/repos/field-mappings.js"
import type { RunTrigger } from "../db/repos/sync-runs.js"
import type { Tenant } from "../db/repos/tenants.js"
import { getClientsForTenant } from "../lib/clients.js"
import { log } from "../lib/log.js"
import type { IntegrationDefinition, IntegrationRunContext } from "./types.js"

/**
 * Verdrahtet den Tenant-Kontext eines Laufs: Client-Factory, tenant-gescoptes
 * getFieldMapping und Child-Logger. Wird von der Run-Route und vom Scheduler
 * benutzt — Tests von run() bauen ihr ctx von Hand (das ist der Punkt).
 */
export function buildRunContext(
  def: IntegrationDefinition,
  tenant: Tenant,
  trigger: RunTrigger,
): IntegrationRunContext {
  return {
    tenantId: tenant.id,
    trigger,
    clients: getClientsForTenant(tenant.id),
    getFieldMapping: (entity) => getFieldMapping(tenant.id, def.id, entity),
    log: log.child({ tenant: tenant.id, integration: def.id }),
  }
}
