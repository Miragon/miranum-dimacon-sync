/**
 * Mandanten-Anlage — bewusst NUR als Ops-Script (kein HTTP-Endpoint):
 * die tenants-Tabelle ist die Zugangs-Allowlist, Anlage bleibt fail-closed.
 *
 * Aufruf (lokal oder via `fly ssh console`):
 *   TENANT_WEBHOOK_SECRET=<secret> pnpm exec tsx scripts/create-tenant.ts --org-id org_XXXX --name "Kunde GmbH"
 *
 * Das Webhook-Secret kommt bewusst aus der Env-Variable, NICHT aus argv —
 * CLI-Argumente landen in Shell-History und Prozessliste; das Secret ist
 * das einzige Credential der offenen /run-Webhooks.
 */
import "dotenv/config"
import { closeDb } from "../src/server/db/client.js"
import { createTenant, getTenantByOrgId } from "../src/server/db/repos/tenants.js"
import { setWebhookSecret } from "../src/server/db/repos/webhook-secrets.js"

// Beide CLI-Formen unterstützen: "--flag wert" und "--flag=wert".
function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  if (idx >= 0) return process.argv[idx + 1]
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`))
  return inline?.slice(flag.length + 1)
}

const orgId = argValue("--org-id")
const name = argValue("--name")
const webhookSecret = process.env.TENANT_WEBHOOK_SECRET

// Der Guard muss BEIDE Formen fangen — sonst rutscht "--webhook-secret=…"
// durch, das Secret landet trotzdem in History/Prozessliste und der Tenant
// würde still OHNE Webhook-Secret angelegt.
const secretOnCli = process.argv.some(
  (a) => a === "--webhook-secret" || a.startsWith("--webhook-secret="),
)

if (!orgId || !name || secretOnCli) {
  console.error(
    'Usage: TENANT_WEBHOOK_SECRET=<secret> tsx scripts/create-tenant.ts --org-id org_XXXX --name "Anzeigename"\n' +
      "(--webhook-secret als CLI-Argument wird abgelehnt — Secret nur via Env)",
  )
  process.exit(1)
}

const existing = await getTenantByOrgId(orgId)
if (existing) {
  console.error(`Tenant für ${orgId} existiert bereits: ${existing.id} (${existing.displayName})`)
  process.exit(1)
}

const tenant = await createTenant({ workosOrgId: orgId, displayName: name })
if (webhookSecret) await setWebhookSecret(tenant.id, webhookSecret)

console.warn(
  JSON.stringify(
    {
      created: tenant.id,
      orgId: tenant.workosOrgId,
      name: tenant.displayName,
      webhookSecret: Boolean(webhookSecret),
    },
    null,
    2,
  ),
)
await closeDb()
