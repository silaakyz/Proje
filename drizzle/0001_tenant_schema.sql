CREATE TYPE "public"."event_status" AS ENUM('draft', 'live', 'completed');--> statement-breakpoint
CREATE TYPE "public"."impact_level" AS ENUM('insufficient_data', 'spend', 'attributable_spend', 'economic_impact');--> statement-breakpoint
CREATE TYPE "public"."module_type" AS ENUM('stage', 'booth', 'session', 'survey');--> statement-breakpoint
CREATE TYPE "public"."subscription_tier" AS ENUM('free', 'pro', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'staff');--> statement-breakpoint
CREATE TABLE "attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_type" text NOT NULL,
	"qr_uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"is_checked_in" boolean DEFAULT false NOT NULL,
	"checked_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendees_ticket_type_not_blank" CHECK (length(trim("attendees"."ticket_type")) > 0),
	CONSTRAINT "attendees_checkin_consistent" CHECK ("attendees"."is_checked_in" = ("attendees"."checked_in_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "attendees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "event_analytics_vectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"impact_level" "impact_level" DEFAULT 'insufficient_data' NOT NULL,
	"net_economic_impact" numeric(18, 2),
	"impact_methodology_version" text,
	"ai_summary_text" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_analytics_vectors_impact_requires_level" CHECK ("event_analytics_vectors"."net_economic_impact" is null or ("event_analytics_vectors"."impact_level" = 'economic_impact' and "event_analytics_vectors"."impact_methodology_version" is not null)),
	CONSTRAINT "event_analytics_vectors_summary_not_blank" CHECK (length(trim("event_analytics_vectors"."ai_summary_text")) > 0)
);
--> statement-breakpoint
ALTER TABLE "event_analytics_vectors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_id_organization_id_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "events_title_not_blank" CHECK (length(trim("events"."title")) > 0),
	CONSTRAINT "events_dates_ordered" CHECK ("events"."end_date" is null or "events"."start_date" is null or "events"."end_date" >= "events"."start_date"),
	CONSTRAINT "events_live_needs_dates" CHECK ("events"."status" = 'draft' or "events"."start_date" is not null)
);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "modules_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"module_type" "module_type" NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modules_registry_event_module_uq" UNIQUE("event_id","module_type"),
	CONSTRAINT "modules_registry_configuration_is_object" CHECK (jsonb_typeof("modules_registry"."configuration") = 'object')
);
--> statement-breakpoint
ALTER TABLE "modules_registry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"subscription_tier" "subscription_tier" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_name_not_blank" CHECK (length(trim("organizations"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'staff' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendees" ADD CONSTRAINT "attendees_event_same_org_fk" FOREIGN KEY ("event_id","organization_id") REFERENCES "public"."events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_analytics_vectors" ADD CONSTRAINT "event_analytics_vectors_event_same_org_fk" FOREIGN KEY ("event_id","organization_id") REFERENCES "public"."events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules_registry" ADD CONSTRAINT "modules_registry_event_same_org_fk" FOREIGN KEY ("event_id","organization_id") REFERENCES "public"."events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendees_qr_uuid_uq" ON "attendees" USING btree ("qr_uuid");--> statement-breakpoint
CREATE INDEX "attendees_organization_id_idx" ON "attendees" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "attendees_event_id_idx" ON "attendees" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_analytics_vectors_organization_id_idx" ON "event_analytics_vectors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "event_analytics_vectors_event_id_idx" ON "event_analytics_vectors" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_analytics_vectors_embedding_hnsw_idx" ON "event_analytics_vectors" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "events_organization_id_status_idx" ON "events" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "modules_registry_organization_id_idx" ON "modules_registry" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "users_organization_id_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE POLICY "attendees_select_own_org" ON "attendees" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("attendees"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "attendees_insert_own_org" ON "attendees" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("attendees"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "attendees_update_own_org" ON "attendees" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("attendees"."organization_id" = (select app.current_organization_id())) WITH CHECK ("attendees"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "event_analytics_vectors_select_own_org" ON "event_analytics_vectors" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("event_analytics_vectors"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "events_select_own_org" ON "events" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("events"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "events_insert_own_org" ON "events" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("events"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "events_update_own_org" ON "events" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("events"."organization_id" = (select app.current_organization_id())) WITH CHECK ("events"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "modules_registry_select_own_org" ON "modules_registry" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("modules_registry"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "modules_registry_insert_own_org" ON "modules_registry" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("modules_registry"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "modules_registry_update_own_org" ON "modules_registry" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("modules_registry"."organization_id" = (select app.current_organization_id())) WITH CHECK ("modules_registry"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "organizations_select_own" ON "organizations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("organizations"."id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "users_select_own_org" ON "users" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("users"."organization_id" = (select app.current_organization_id()));