import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const credentialSystem = pgEnum("credential_system", ["dimacon", "clockin", "lexoffice"])
export const runTrigger = pgEnum("run_trigger", ["manual", "cron", "webhook", "mcp"])
export const runStatus = pgEnum("run_status", ["running", "success", "error"])

/** Ein Mandant = eine WorkOS-Organisation. Die Tabelle IST die Zugangs-Allowlist. */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workosOrgId: text("workos_org_id").notNull(),
    displayName: text("display_name").notNull(),
    active: boolean("active").notNull().default(true),
    // 'manual' | 'workos-sync' — der Org-Sync (tenant-sync.ts) fasst
    // ausschließlich eigene Zeilen an; manuell angelegte Mandanten (inkl.
    // org_dev) sind strukturell immun gegen Auto-Deaktivierung/-Rename.
    managedBy: text("managed_by").notNull().default("manual"),
    // Wer hat deaktiviert? Der Sync reaktiviert NUR 'workos-sync'-
    // Deaktivierungen — ein manuelles active=false (Ops-Not-Aus) bleibt
    // stehen, auch wenn das Feature-Flag der Org weiterhin gesetzt ist.
    deactivatedBy: text("deactivated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("tenants_workos_org_id_uq").on(t.workosOrgId)],
)

/**
 * API-Zugangsdaten je (Mandant, System). `secret` ist der AES-256-GCM-Envelope-
 * String "v1:<keyId>:<ivB64>:<tagB64>:<ctB64>" über ein JSON-Secret-Objekt;
 * `config` trägt Nicht-Geheimes (baseUrl, Dimacon-tenant) im Klartext, damit
 * die UI-Statusliste ohne Decrypt auskommt.
 */
export const tenantCredentials = pgTable(
  "tenant_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    system: credentialSystem("system").notNull(),
    secret: text("secret").notNull(),
    config: jsonb("config").notNull().default({}).$type<Record<string, string>>(),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("tenant_credentials_tenant_system_uq").on(t.tenantId, t.system)],
)

export const scheduleSettings = pgTable(
  "schedule_settings",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    cron: text("cron"),
    timezone: text("timezone").notNull().default("Europe/Berlin"),
    // Persistenter Run-Umfang je (Mandant, Integration): serverseitig gegen
    // `def.inputSchema` validiert (generisch, kein integrationsspezifisches
    // Schema in der Scheduler-Tabelle) und bewusst OHNE `date` — beim Cron
    // ist das Datum immer „heute". `{}` reproduziert exakt das alte
    // Verhalten (Zod-Defaults des jeweiligen inputSchema).
    runDefaults: jsonb("run_defaults").notNull().default({}).$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.integrationId] })],
)

export const fieldMappings = pgTable(
  "field_mappings",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    entity: text("entity").notNull(),
    mapping: jsonb("mapping").notNull().$type<{ version: 1; rules: unknown[] }>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.integrationId, t.entity] })],
)

/** Webhook-Secret identifiziert den Mandanten (sha256-Hex-Digest, nie Klartext). */
export const tenantWebhookSecrets = pgTable(
  "tenant_webhook_secrets",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tenant_webhook_secrets_tenant_uq").on(t.tenantId),
    uniqueIndex("tenant_webhook_secrets_hash_uq").on(t.secretHash),
  ],
)

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    trigger: runTrigger("trigger").notNull(),
    status: runStatus("status").notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    input: jsonb("input").notNull().default({}),
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("sync_runs_tenant_integration_started_idx").on(
      t.tenantId,
      t.integrationId,
      t.startedAt.desc(),
    ),
  ],
)

/** Key-Value-Ablage für dauerhafte Marker (z. B. "legacy-seed"). */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})
