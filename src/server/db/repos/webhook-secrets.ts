import { createHash, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { getDb } from "../client.js"
import { tenantWebhookSecrets, tenants } from "../schema.js"
import type { Tenant } from "./tenants.js"

export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex")
}

/**
 * Identifiziert den Mandanten über sein Webhook-Secret: indizierter
 * sha256-Lookup + timingSafeEqual-Nachprüfung auf dem Digest. Bei 256 Bit
 * Digest-Entropie ist das Index-Timing nicht ausnutzbar; der konstante
 * Vergleich bleibt als Disziplin erhalten.
 */
export async function findTenantBySecret(secret: string): Promise<Tenant | undefined> {
  const digest = hashWebhookSecret(secret)
  const rows = await getDb()
    .select({ tenant: tenants, secretHash: tenantWebhookSecrets.secretHash })
    .from(tenantWebhookSecrets)
    .innerJoin(tenants, eq(tenantWebhookSecrets.tenantId, tenants.id))
    // Deaktivierte Mandanten matchen nie — auch der Status-Pfad (healthz)
    // darf mit ihrem Secret keine tenant-gescopten Daten mehr liefern.
    .where(and(eq(tenantWebhookSecrets.secretHash, digest), eq(tenants.active, true)))
    .limit(1)
  const row = rows[0]
  if (!row) return undefined
  const a = Buffer.from(digest, "hex")
  const b = Buffer.from(row.secretHash, "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  return row.tenant
}

export async function setWebhookSecret(tenantId: string, secret: string): Promise<void> {
  const secretHash = hashWebhookSecret(secret)
  await getDb().insert(tenantWebhookSecrets).values({ tenantId, secretHash }).onConflictDoUpdate({
    target: tenantWebhookSecrets.tenantId,
    set: { secretHash },
  })
}

/** Fire-and-forget-Zeitstempel; Fehler bewusst verschluckt. */
export function touchLastUsed(tenantId: string): void {
  void getDb()
    .update(tenantWebhookSecrets)
    .set({ lastUsedAt: new Date() })
    .where(eq(tenantWebhookSecrets.tenantId, tenantId))
    .catch(() => undefined)
}
