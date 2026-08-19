/**
 * Re-Encrypt-Sweep für die Key-Rotation: liest alle tenant_credentials,
 * entschlüsselt mit dem Ring (alte keyIds inklusive) und schreibt mit dem
 * aktuellen Key neu. Idempotent — bereits aktuelle Zeilen werden übersprungen.
 *
 * Aufruf (lokal oder via `fly ssh console`):
 *   pnpm exec tsx src/server/db/rotate-credentials.ts
 *
 * Danach prüfen, dass keine Zeile mehr am alten Key hängt, bevor der alte
 * Eintrag aus CREDENTIAL_KEYS entfernt wird:
 *   SELECT count(*) FROM tenant_credentials WHERE secret NOT LIKE 'v1:<aktuelle keyId>:%';
 */
import "dotenv/config"
import { and, eq } from "drizzle-orm"
import {
  credentialAad,
  currentKeyId,
  decryptSecret,
  encryptSecret,
  needsReencrypt,
} from "../lib/crypto.js"
import { closeDb, getDb } from "./client.js"
import { tenantCredentials } from "./schema.js"

const db = getDb()
const rows = await db.select().from(tenantCredentials)

let rotated = 0
let skipped = 0
let concurrent = 0
for (const row of rows) {
  if (!needsReencrypt(row.secret)) {
    skipped++
    continue
  }
  const aad = credentialAad(row.tenantId, row.system)
  const plaintext = decryptSecret(row.secret, aad)
  // Compare-and-swap gegen den Snapshot: ein PUT während des Sweeps darf
  // nicht mit dem re-verschlüsselten ALTEN Token überschrieben werden
  // (Lost-Update — die Zeile sähe danach frisch rotiert aus).
  const updated = await db
    .update(tenantCredentials)
    .set({ secret: encryptSecret(plaintext, aad), updatedAt: new Date() })
    .where(and(eq(tenantCredentials.id, row.id), eq(tenantCredentials.secret, row.secret)))
    .returning({ id: tenantCredentials.id })
  if (updated.length === 0) concurrent++
  else rotated++
}

console.warn(
  JSON.stringify(
    {
      currentKeyId: currentKeyId(),
      rotated,
      alreadyCurrent: skipped,
      skippedConcurrentWrite: concurrent,
    },
    null,
    2,
  ),
)
await closeDb()
