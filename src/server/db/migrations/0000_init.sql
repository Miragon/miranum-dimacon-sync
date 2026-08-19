CREATE TYPE "public"."credential_system" AS ENUM('dimacon', 'clockin', 'lexoffice');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'success', 'error');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('manual', 'cron', 'webhook', 'mcp');--> statement-breakpoint
CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_mappings" (
	"tenant_id" uuid NOT NULL,
	"integration_id" text NOT NULL,
	"entity" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_mappings_tenant_id_integration_id_entity_pk" PRIMARY KEY("tenant_id","integration_id","entity")
);
--> statement-breakpoint
CREATE TABLE "schedule_settings" (
	"tenant_id" uuid NOT NULL,
	"integration_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cron" text,
	"timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_settings_tenant_id_integration_id_pk" PRIMARY KEY("tenant_id","integration_id")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" text NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "tenant_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"system" "credential_system" NOT NULL,
	"secret" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_webhook_secrets" (
	"tenant_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workos_org_id" text NOT NULL,
	"display_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "field_mappings" ADD CONSTRAINT "field_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_credentials" ADD CONSTRAINT "tenant_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_webhook_secrets" ADD CONSTRAINT "tenant_webhook_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_tenant_integration_started_idx" ON "sync_runs" USING btree ("tenant_id","integration_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_credentials_tenant_system_uq" ON "tenant_credentials" USING btree ("tenant_id","system");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_webhook_secrets_tenant_uq" ON "tenant_webhook_secrets" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_webhook_secrets_hash_uq" ON "tenant_webhook_secrets" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_workos_org_id_uq" ON "tenants" USING btree ("workos_org_id");