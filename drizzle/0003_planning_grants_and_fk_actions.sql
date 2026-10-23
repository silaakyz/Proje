-- Hand-written. Two things drizzle-kit cannot express.

-- 1. Column-scoped ON DELETE SET NULL (PostgreSQL 15+).
--    A composite FK with plain SET NULL nulls EVERY referencing column, including the NOT NULL
--    organization_id, so deleting a user or proposal would fail. Only the nullable column is cleared.
alter table "tasks" drop constraint "tasks_proposal_same_org_fk";
--> statement-breakpoint
alter table "tasks" add constraint "tasks_proposal_same_org_fk"
  foreign key ("proposal_id", "organization_id") references "public"."proposals" ("id", "organization_id")
  on delete set null ("proposal_id");
--> statement-breakpoint
alter table "tasks" drop constraint "tasks_assignee_same_org_fk";
--> statement-breakpoint
alter table "tasks" add constraint "tasks_assignee_same_org_fk"
  foreign key ("assigned_to", "organization_id") references "public"."users" ("id", "organization_id")
  on delete set null ("assigned_to");
--> statement-breakpoint
alter table "proposals" drop constraint "proposals_decided_by_same_org_fk";
--> statement-breakpoint
alter table "proposals" add constraint "proposals_decided_by_same_org_fk"
  foreign key ("decided_by", "organization_id") references "public"."users" ("id", "organization_id")
  on delete set null ("decided_by");
--> statement-breakpoint

-- 2. Privileges. RLS decides WHICH ROWS; grants decide WHICH COLUMNS / OPERATIONS.
--    Clients may change a task's status only (updated_at is maintained by the same UPDATE).
revoke insert, update, delete on "tasks" from authenticated, anon;
--> statement-breakpoint
grant update ("status", "updated_at") on "tasks" to authenticated;
--> statement-breakpoint
--    AI drafts, KPIs and survey questions are server-only; no policy exists for writes either.
revoke insert, update, delete on "proposals", "event_kpis", "survey_questions" from authenticated, anon;
