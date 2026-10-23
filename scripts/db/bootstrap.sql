-- Platform prerequisites of the EIP schema on a plain PostgreSQL (15+) server.
--
-- The Drizzle migrations (drizzle/) expect what a managed platform used to provide: the pgvector extension in
-- schema `extensions`, the database roles RLS policies are written for (anon, authenticated, service_role), an
-- `auth` schema with the user table that public.users references, and auth.uid() returning the signed-in user
-- of the current transaction (set by src/db/rls.ts withRls). This file creates exactly that, plus the session
-- table of the application's own email + password sign-in (src/server/auth/session.ts) and the request counters
-- of the rate limiter (src/server/rate-limit.ts).
--
-- These server-only tables live outside `public` on purpose: drizzle-kit manages only `public`
-- (drizzle.config.ts schemaFilter), so they are created and evolved here, not by migrations.
--
-- Idempotent: `npm run drizzle:migrate` runs it before every migration run; running it again changes nothing.
-- Run it as the database owner (or a superuser): it creates roles and an extension and sets the search path.
-- The test databases (tests/db/helpers.ts) are created from this same file.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

do $$
begin
  execute format('alter database %I set search_path to "$user", public, extensions', current_database());
end
$$;
set search_path to "$user", public, extensions;

-- Roles the RLS policies are written for. NOLOGIN: nobody connects as them; the server switches into
-- `authenticated` inside a transaction (withRls) after it has verified the session.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$$;

-- The login role that runs migrations and the app must be able to SET ROLE authenticated.
do $$
begin
  if not pg_has_role(current_user, 'authenticated', 'MEMBER') then
    execute format('grant anon, authenticated, service_role to %I', current_user);
  end if;
end
$$;

-- Accounts and sessions. Only the server reads these (as the owner); browser roles have no access.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
alter table auth.users alter column id set default gen_random_uuid();
alter table auth.users add column if not exists password_hash text;
alter table auth.users add column if not exists created_at timestamptz not null default now();
alter table auth.users add column if not exists last_sign_in_at timestamptz;
create unique index if not exists auth_users_email_lower_key on auth.users (lower(email));

create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- sha256 of the session token; the token itself exists only in the browser cookie
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index if not exists auth_sessions_user_id_idx on auth.sessions (user_id);
create index if not exists auth_sessions_expires_at_idx on auth.sessions (expires_at);

-- Password reset links (src/server/auth/password-reset.ts): sha256 of the one-time token, short expiry, used once.
create table if not exists auth.password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists auth_password_resets_user_id_idx on auth.password_resets (user_id);

-- Request counters of the rate limiter: one row per key and fixed window (sliding estimate in code).
create schema if not exists app_private;
create table if not exists app_private.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);
create index if not exists rate_limits_window_start_idx on app_private.rate_limits (window_start);

revoke all on all tables in schema auth from public, anon, authenticated, service_role;
revoke all on all tables in schema app_private from public, anon, authenticated, service_role;
revoke all on schema app_private from public;

-- The signed-in user of the current transaction (withRls sets request.jwt.claim.sub / request.jwt.claims).
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Default table privileges the migrations were written against (RLS is the guard; 0006 then narrows them).
-- Only on a database that has not been migrated yet: re-running this after 0006 must not undo the hardening.
do $$
begin
  if to_regclass('drizzle.__drizzle_migrations') is null then
    execute 'alter default privileges in schema public grant all on tables to anon, authenticated, service_role';
    execute 'alter default privileges in schema public grant all on sequences to anon, authenticated, service_role';
  end if;
end
$$;
