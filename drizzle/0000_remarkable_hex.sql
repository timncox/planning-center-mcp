CREATE TABLE "connector_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pco_connection_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"name" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pco_connection_id" uuid,
	"tool_name" text,
	"success" boolean,
	"execution_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pco_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"church_name" text,
	"pco_organization_id" text,
	"pco_person_id" text,
	"pco_person_name" text,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pco_connection_id" uuid NOT NULL,
	"service_type_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"plan_title" text,
	"plan_date" text,
	"wins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"do_again" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avoid_next_time" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_tokens" ADD CONSTRAINT "connector_tokens_pco_connection_id_pco_connections_id_fk" FOREIGN KEY ("pco_connection_id") REFERENCES "public"."pco_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_audit_logs" ADD CONSTRAINT "mcp_audit_logs_pco_connection_id_pco_connections_id_fk" FOREIGN KEY ("pco_connection_id") REFERENCES "public"."pco_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_feedback" ADD CONSTRAINT "service_feedback_pco_connection_id_pco_connections_id_fk" FOREIGN KEY ("pco_connection_id") REFERENCES "public"."pco_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_tokens_token_hash_uniq" ON "connector_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "connector_tokens_connection_idx" ON "connector_tokens" USING btree ("pco_connection_id");--> statement-breakpoint
CREATE INDEX "mcp_audit_logs_connection_idx" ON "mcp_audit_logs" USING btree ("pco_connection_id");--> statement-breakpoint
CREATE INDEX "service_feedback_connection_idx" ON "service_feedback" USING btree ("pco_connection_id");--> statement-breakpoint
CREATE INDEX "service_feedback_plan_idx" ON "service_feedback" USING btree ("service_type_id","plan_id");--> statement-breakpoint
CREATE INDEX "service_feedback_tags_idx" ON "service_feedback" USING gin ("tags");