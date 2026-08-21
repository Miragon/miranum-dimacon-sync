ALTER TABLE "tenants" ADD COLUMN "managed_by" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deactivated_by" text;