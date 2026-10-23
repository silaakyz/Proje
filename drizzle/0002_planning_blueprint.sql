-- Edited after generation: drizzle-kit emitted this UNIQUE constraint after the foreign keys that
-- reference it, which PostgreSQL rejects (42830). It must come first.
ALTER TABLE "users" ADD CONSTRAINT "users_id_organization_id_uq" UNIQUE("id","organization_id");--> statement-breakpoint
CREATE TYPE "public"."kpi_data_source" AS ENUM('survey', 'ticket_sales', 'system');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."survey_question_type" AS ENUM('text', 'rating', 'boolean');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('TODO', 'IN_PROGRESS', 'DONE');--> statement-breakpoint
CREATE TABLE "event_kpis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"metric_name" varchar(64) NOT NULL,
	"target_value" numeric(18, 4) NOT NULL,
	"actual_value" numeric(18, 4),
	"data_source" "kpi_data_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_kpis_event_metric_uq" UNIQUE("event_id","metric_name"),
	CONSTRAINT "event_kpis_metric_name_format" CHECK ("event_kpis"."metric_name" ~ '^[a-z][a-z0-9_]{1,63}$')
);
--> statement-breakpoint
ALTER TABLE "event_kpis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "proposal_status" DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb NOT NULL,
	"ai_fingerprint" char(64) NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"error_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_id_organization_id_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "proposals_payload_is_object" CHECK (jsonb_typeof("proposals"."payload") = 'object'),
	CONSTRAINT "proposals_fingerprint_hex" CHECK ("proposals"."ai_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "proposals_expiry_after_creation" CHECK ("proposals"."expires_at" > "proposals"."created_at"),
	CONSTRAINT "proposals_decision_recorded" CHECK (("proposals"."status" in ('APPROVED', 'REJECTED')) = ("proposals"."decided_at" is not null)),
	CONSTRAINT "proposals_failed_has_reason" CHECK ("proposals"."status" <> 'FAILED' or "proposals"."error_message" is not null)
);
--> statement-breakpoint
ALTER TABLE "proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "survey_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"question_text" text NOT NULL,
	"type" "survey_question_type" NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey_questions_text_not_blank" CHECK (length(trim("survey_questions"."question_text")) > 0),
	CONSTRAINT "survey_questions_position_non_negative" CHECK ("survey_questions"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "survey_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"proposal_id" uuid,
	"title" varchar(200) NOT NULL,
	"status" "task_status" DEFAULT 'TODO' NOT NULL,
	"assigned_to" uuid,
	"is_ai_generated" boolean DEFAULT false NOT NULL,
	"ai_fingerprint" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_title_not_blank" CHECK (length(trim("tasks"."title")) > 0),
	CONSTRAINT "tasks_ai_fingerprint_only_for_ai" CHECK ("tasks"."ai_fingerprint" is null or "tasks"."is_ai_generated")
);
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_kpis" ADD CONSTRAINT "event_kpis_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_kpis" ADD CONSTRAINT "event_kpis_event_same_org_fk" FOREIGN KEY ("event_id","organization_id") REFERENCES "public"."events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_event_same_org_fk" FOREIGN KEY ("event_id","organization_id") REFERENCES "public"."events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_same_org_fk" FOREIGN KEY ("decided_by","organization_id") REFERENCES "public"."users"("id","organization_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_event_same_org_fk" FOREIGN KEY ("event_id","organization_id") REFERENCES "public"."events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_event_same_org_fk" FOREIGN KEY ("event_id","organization_id") REFERENCES "public"."events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_proposal_same_org_fk" FOREIGN KEY ("proposal_id","organization_id") REFERENCES "public"."proposals"("id","organization_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_same_org_fk" FOREIGN KEY ("assigned_to","organization_id") REFERENCES "public"."users"("id","organization_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_kpis_organization_id_idx" ON "event_kpis" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "proposals_org_event_status_idx" ON "proposals" USING btree ("organization_id","event_id","status");--> statement-breakpoint
CREATE INDEX "survey_questions_org_event_position_idx" ON "survey_questions" USING btree ("organization_id","event_id","position");--> statement-breakpoint
CREATE INDEX "tasks_org_event_status_idx" ON "tasks" USING btree ("organization_id","event_id","status");--> statement-breakpoint
CREATE INDEX "tasks_assigned_to_idx" ON "tasks" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "tasks_proposal_id_idx" ON "tasks" USING btree ("proposal_id");--> statement-breakpoint
CREATE POLICY "event_kpis_select_own_org" ON "event_kpis" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("event_kpis"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "proposals_select_own_org" ON "proposals" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("proposals"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "survey_questions_select_own_org" ON "survey_questions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("survey_questions"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "tasks_select_own_org" ON "tasks" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("tasks"."organization_id" = (select app.current_organization_id()));--> statement-breakpoint
CREATE POLICY "tasks_update_status_own_org" ON "tasks" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("tasks"."organization_id" = (select app.current_organization_id())) WITH CHECK ("tasks"."organization_id" = (select app.current_organization_id()));