import { sql } from "drizzle-orm"
import { credentialAad, encryptSecret, isEncryptionConfigured } from "../lib/crypto.js"
import { formatError } from "../lib/errors.js"
import { loadLegacySettingsFile } from "../lib/legacy-settings.js"
import { log } from "../lib/log.js"
import { ScheduleSettingsSchema } from "../lib/schedule-schema.js"
import type { Db } from "./client.js"
import { hashWebhookSecret } from "./repos/webhook-secrets.js"
import type { CredentialSystem } from "./repos/credentials.js"
import {
  appMeta,
  fieldMappings,
  scheduleSettings,
  tenantCredentials,
  tenantWebhookSecrets,
  tenants,
} from "./schema.js"

const SEED_MARKER_KEY = "legacy-seed"
const LEGACY_INTEGRATION_ID = "dimacon-clockin"

export interface SeedReport {
  seeded: boolean
  reason?: "already_seeded" | "tenants_exist" | "no_org_id" | "encryption_not_configured"
  systems: CredentialSystem[]
  schedules: number
  mappings: number
  webhookSecret: boolean
}

const SKIPPED: Omit<SeedReport, "reason"> = {
  seeded: false,
  systems: [],
  schedules: 0,
  mappings: 0,
  webhookSecret: false,
}

interface EnvCredentialPlan {
  system: CredentialSystem
  secretField: "apiToken" | "apiKey"
  secretVar: string
  requiredConfig: Record<string, string> // config-Feld -> Env-Var
  optionalConfig: Record<string, string>
}

const ENV_PLANS: EnvCredentialPlan[] = [
  {
    system: "dimacon",
    secretField: "apiToken",
    secretVar: "DIMACON_API_TOKEN",
    requiredConfig: { baseUrl: "DIMACON_BASE_URL", tenant: "DIMACON_TENANT" },
    optionalConfig: {},
  },
  {
    system: "clockin",
    secretField: "apiToken",
    secretVar: "CLOCKIN_API_TOKEN",
    requiredConfig: {},
    optionalConfig: { baseUrl: "CLOCKIN_BASE_URL" },
  },
  {
    system: "lexoffice",
    secretField: "apiKey",
    secretVar: "LEXWARE_OFFICE_API_KEY",
    requiredConfig: {},
    optionalConfig: { baseUrl: "LEXWARE_OFFICE_BASE_URL" },
  },
]

function envValue(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

/**
 * Einmaliger Import des Single-Tenant-Altbestands (Env-Credentials +
 * settings.json + Webhook-Secret) in den ersten Mandanten. Läuft beim Boot
 * unter dem Advisory-Lock aus migrate.ts. Doppelt abgesichert: dauerhafter
 * app_meta-Marker UND Leertabellen-Check — nach dem Cutover-Env-Cleanup kann
 * auch ein DB-Restore keine veralteten Tokens mehr wiederbeleben.
 */
export async function seedLegacyTenant(db: Db): Promise<SeedReport> {
  const markerRows = await db.execute(
    sql`SELECT key FROM app_meta WHERE key = ${SEED_MARKER_KEY} LIMIT 1`,
  )
  if (markerRows.rows.length > 0) {
    return { ...SKIPPED, reason: "already_seeded" }
  }

  const tenantCount = await db.execute(sql`SELECT count(*)::int AS n FROM tenants`)
  if ((tenantCount.rows[0] as { n: number }).n > 0) {
    return { ...SKIPPED, reason: "tenants_exist" }
  }

  const orgId = envValue("WORKOS_REQUIRED_ORG_ID")
  if (!orgId) {
    log.info("legacy seed skipped: no WORKOS_REQUIRED_ORG_ID", {})
    return { ...SKIPPED, reason: "no_org_id" }
  }

  if (!isEncryptionConfigured()) {
    // Bewusst kein Fatal: der Boot-Guard verlangt CREDENTIAL_KEYS in Prod;
    // in Dev ohne Keys startet die App, aber der Seed importiert nichts.
    log.warn("legacy seed skipped: CREDENTIAL_KEYS not configured", {})
    return { ...SKIPPED, reason: "encryption_not_configured" }
  }

  const settingsFile = await loadLegacySettingsFile()

  const report: SeedReport = {
    seeded: true,
    systems: [],
    schedules: 0,
    mappings: 0,
    webhookSecret: false,
  }

  await db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({
        workosOrgId: orgId,
        displayName: envValue("SEED_TENANT_NAME") ?? orgId,
      })
      .returning()

    for (const plan of ENV_PLANS) {
      const secretValue = envValue(plan.secretVar)
      const config: Record<string, string> = {}
      const missing: string[] = secretValue ? [] : [plan.secretVar]
      for (const [field, envVar] of Object.entries(plan.requiredConfig)) {
        const value = envValue(envVar)
        if (value) config[field] = value
        else missing.push(envVar)
      }
      for (const [field, envVar] of Object.entries(plan.optionalConfig)) {
        const value = envValue(envVar)
        if (value) config[field] = value
      }
      if (missing.length > 0) {
        // Unvollständiges System überspringen — entspricht dem heutigen
        // Verhalten (Integration ist dann "nicht konfiguriert", kein Crash).
        log.info("legacy seed: system skipped, incomplete env", {
          system: plan.system,
          missing,
        })
        continue
      }
      const secret = encryptSecret(
        JSON.stringify({ [plan.secretField]: secretValue }),
        credentialAad(tenant.id, plan.system),
      )
      await tx
        .insert(tenantCredentials)
        .values({ tenantId: tenant.id, system: plan.system, secret, config, updatedBy: "seed" })
      report.systems.push(plan.system)
    }

    if (settingsFile) {
      for (const [integrationId, schedule] of Object.entries(settingsFile.integrations)) {
        await tx.insert(scheduleSettings).values({
          tenantId: tenant.id,
          integrationId,
          enabled: schedule.enabled,
          cron: schedule.cron ?? null,
          timezone: schedule.timezone,
        })
        report.schedules++
      }
      for (const [integrationId, entities] of Object.entries(settingsFile.fieldMappings)) {
        for (const [entity, mapping] of Object.entries(entities)) {
          await tx.insert(fieldMappings).values({
            tenantId: tenant.id,
            integrationId,
            entity,
            mapping,
          })
          report.mappings++
        }
      }
    } else {
      // Kein settings.json: SYNC_CRON/SYNC_TZ als Erst-Seed honorieren —
      // exakt das heutige seedFromEnv()-Verhalten, nur Ziel = DB. Durch das
      // Schema validieren (trim/min/max), damit nie eine Zeile entsteht,
      // an der getScheduleSettings später mit ZodError scheitert.
      const seedSchedule = ScheduleSettingsSchema.safeParse({
        enabled: true,
        cron: envValue("SYNC_CRON"),
        timezone: envValue("SYNC_TZ"),
      })
      if (seedSchedule.success && seedSchedule.data.cron) {
        await tx.insert(scheduleSettings).values({
          tenantId: tenant.id,
          integrationId: LEGACY_INTEGRATION_ID,
          enabled: true,
          cron: seedSchedule.data.cron,
          timezone: seedSchedule.data.timezone,
        })
        report.schedules++
      }
    }

    const webhookSecret = envValue("SYNC_WEBHOOK_SECRET")
    if (webhookSecret) {
      await tx.insert(tenantWebhookSecrets).values({
        tenantId: tenant.id,
        secretHash: hashWebhookSecret(webhookSecret),
      })
      report.webhookSecret = true
    }

    await tx.insert(appMeta).values({
      key: SEED_MARKER_KEY,
      value: {
        tenantId: tenant.id,
        orgId,
        systems: report.systems,
        settingsFile: settingsFile ? "found" : "missing",
      },
    })
  })

  log.info("legacy seed complete", {
    orgId,
    systems: report.systems,
    schedules: report.schedules,
    mappings: report.mappings,
    webhookSecret: report.webhookSecret,
  })
  return report
}

/**
 * Boot-Wrapper: loggt und wirft weiter. Ein halber Seed ist durch die
 * Transaktion zurückgerollt; der Start MUSS dann abbrechen, sonst läuft Prod
 * ohne Mandanten und Logins/Webhooks schlagen diffus fehl.
 */
export async function seedOrThrow(db: Db): Promise<SeedReport> {
  try {
    return await seedLegacyTenant(db)
  } catch (err) {
    log.error("legacy seed failed", { error: formatError(err) })
    throw err
  }
}
