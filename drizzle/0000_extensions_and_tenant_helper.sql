-- Hand-written; runs before the generated tables (drizzle-kit cannot express extensions or functions).
-- Drizzle's migrator sends each chunk between breakpoints as ONE prepared statement, so every
-- statement must be followed by a statement-breakpoint marker.

-- pgvector. Supabase installs extensions into `extensions`, which is on the default search_path.
create schema if not exists extensions;
--> statement-breakpoint
create extension if not exists vector with schema extensions;
--> statement-breakpoint

-- Tenant resolution for RLS.
-- SECURITY DEFINER so it can read public.users without triggering users' own RLS policy
-- (a policy on `users` that queries `users` would recurse). plpgsql so the body is not bound to
-- public.users at creation time; that table is created by the next migration.
-- STABLE + wrapped in (select …) by every policy, so Postgres evaluates it once per statement.
create schema if not exists app;
--> statement-breakpoint
create or replace function app.current_organization_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (select u.organization_id from public.users u where u.id = (select auth.uid()));
end;
$$;
--> statement-breakpoint
revoke all on function app.current_organization_id() from public, anon;
--> statement-breakpoint
grant usage on schema app to authenticated;
--> statement-breakpoint
grant execute on function app.current_organization_id() to authenticated;
