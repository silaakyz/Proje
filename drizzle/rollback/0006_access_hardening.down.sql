-- ROLLBACK for 0006_access_hardening. NOT part of the migration journal: drizzle's migrator never runs
-- this file. Apply it by hand, as the role that ran the migrations, in ONE transaction that stops at the
-- first error:   psql -v ON_ERROR_STOP=1 -f drizzle/rollback/0006_access_hardening.down.sql
--
-- Preconditions, checked below before anything is changed (the script stops otherwise):
--   * drizzle.__drizzle_migrations exists with drizzle-orm's columns (id integer, hash text,
--     created_at bigint) — the default table; a custom migrations table/schema is not supported here;
--   * 0006 is recorded exactly once (created_at = its journal "when", 1792242997447) with the hash of the
--     0006 file this rollback belongs to (sha256 b267f0f08c0bb41e13ea8f891be022ebc21c405813522ccd4a3afe8c81e01e9b);
--     Earlier development versions of 0006 exist only in local scratch databases (e.g. sha256 36c7a6eb…
--     from commit 13e53f8, 9ac2fd62…, and older ones whose hash was not recorded). They are refused on
--     purpose: their objects may differ from what this script restores. Recreate such databases instead.
--   * 0006 is the LAST applied migration: no row has a later created_at or a higher id. drizzle-orm only
--     compares against the latest created_at, so with a later migration recorded, removing the 0006 row
--     would never make the migrator re-apply 0006 — roll the later migrations back first.
--   The migrations table is locked (EXCLUSIVE) for the rest of the transaction, so no migrator can record
--   anything in between. At the end the 0006 row is deleted in the same transaction: the next migrate run
--   re-applies 0006. Either everything below happens, or nothing.
--
-- Privileges are restored from the snapshots 0006 took BEFORE changing anything:
--   app.acl_before_0006          table and column privileges of every public table, and the
--                                privileges of every public sequence;
--   app.default_acl_before_0006  default privileges (creator role, schema or global, object type,
--                                grantee, privilege, grant option).
-- Table/column/sequence privileges of anon/authenticated/PUBLIC are set back exactly as recorded.
-- Default privileges: only what 0006 itself removes is granted back (tables and sequences in schema public
-- and global entries; TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on tables in other schemas). Nothing is revoked,
-- so other default privileges and changes made after 0006 are left as they are. Without both snapshots
-- this script refuses to run instead of guessing.
-- Policies are restored to their 0005 (= 0001) definitions; the role helper is dropped.
-- This re-opens the pre-0006 (weaker) browser surface: use it only to undo a failed deployment.
-- Tested in tests/db/access-hardening.test.ts (Supabase-default and non-default pre-0006 privileges).
begin;

-- precondition: 0006 is the last applied migration, recorded once, and is this file's version
do $$
declare
  expected_when constant bigint := 1792242997447;
  expected_hash constant text := 'b267f0f08c0bb41e13ea8f891be022ebc21c405813522ccd4a3afe8c81e01e9b';
  tbl regclass := to_regclass('drizzle.__drizzle_migrations');
  cols int;
  n int;
  rec record;
begin
  if tbl is null then
    raise exception 'rollback 0006: drizzle.__drizzle_migrations not found (custom migrations table? not supported by this script)';
  end if;
  select count(*) into cols from pg_attribute
  where attrelid = tbl and attnum > 0 and not attisdropped
    and ((attname = 'id' and atttypid = 'integer'::regtype) or (attname = 'hash' and atttypid = 'text'::regtype)
         or (attname = 'created_at' and atttypid = 'bigint'::regtype));
  if cols <> 3 then
    raise exception 'rollback 0006: drizzle.__drizzle_migrations does not have the expected columns id integer, hash text, created_at bigint';
  end if;
  execute 'lock table drizzle.__drizzle_migrations in exclusive mode';
  execute 'select count(*) from drizzle.__drizzle_migrations where created_at = $1' into n using expected_when;
  if n <> 1 then
    raise exception 'rollback 0006: expected exactly one 0006 row (created_at %), found %', expected_when, n;
  end if;
  execute 'select id, hash from drizzle.__drizzle_migrations where created_at = $1' into rec using expected_when;
  if rec.hash is distinct from expected_hash then
    raise exception 'rollback 0006: the recorded 0006 (hash %) is not the version this rollback belongs to (%)', rec.hash, expected_hash;
  end if;
  execute 'select count(*) from drizzle.__drizzle_migrations where created_at > $1 or id > $2' into n using expected_when, rec.id;
  if n > 0 then
    raise exception 'rollback 0006: % migration(s) were applied after 0006; roll them back first', n;
  end if;
end $$;

do $$
begin
  if to_regclass('app.acl_before_0006') is null then
    raise exception 'app.acl_before_0006 is missing: cannot restore the pre-0006 privileges exactly';
  end if;
  if to_regclass('app.default_acl_before_0006') is null then
    raise exception 'app.default_acl_before_0006 is missing: cannot restore the pre-0006 default privileges exactly';
  end if;
end $$;

-- policies as in 0001
alter policy "attendees_select_own_org" on "attendees" to authenticated
  using ("attendees"."organization_id" = (select app.current_organization_id()));
create policy "attendees_insert_own_org" on "attendees" as permissive for insert to "authenticated"
  with check ("attendees"."organization_id" = (select app.current_organization_id()));
create policy "attendees_update_own_org" on "attendees" as permissive for update to "authenticated"
  using ("attendees"."organization_id" = (select app.current_organization_id()))
  with check ("attendees"."organization_id" = (select app.current_organization_id()));
alter policy "events_insert_own_org" on "events" to authenticated
  with check ("events"."organization_id" = (select app.current_organization_id()));
alter policy "events_update_own_org" on "events" to authenticated
  using ("events"."organization_id" = (select app.current_organization_id()))
  with check ("events"."organization_id" = (select app.current_organization_id()));
alter policy "modules_registry_insert_own_org" on "modules_registry" to authenticated
  with check ("modules_registry"."organization_id" = (select app.current_organization_id()));
alter policy "modules_registry_update_own_org" on "modules_registry" to authenticated
  using ("modules_registry"."organization_id" = (select app.current_organization_id()))
  with check ("modules_registry"."organization_id" = (select app.current_organization_id()));

-- privileges: per table, drop everything anon/authenticated/PUBLIC hold now (REVOKE on a table also
-- revokes its column privileges), then grant back exactly what the snapshot recorded.
do $$
declare
  t record;
  g record;
  col text;
  kind text;
begin
  for t in select * from app.acl_before_0006 loop
    continue when to_regclass(format('public.%I', t.table_name)) is null;
    kind := case t.relkind when 'S' then 'sequence' else 'table' end;
    execute format('revoke all on %s public.%I from anon, authenticated, public', kind, t.table_name);
    for g in
      select case when e.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(e.grantee)) end as grantee, e.privilege_type, e.is_grantable
      from aclexplode(coalesce(t.table_acl, '{}')::aclitem[]) e
      where e.grantee = 0 or pg_get_userbyid(e.grantee) in ('anon', 'authenticated')
    loop
      execute format('grant %s on %s public.%I to %s%s', g.privilege_type, kind, t.table_name, g.grantee,
        case when g.is_grantable then ' with grant option' else '' end);
    end loop;
    for col in select jsonb_object_keys(t.column_acls) loop
      for g in
        select case when e.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(e.grantee)) end as grantee, e.privilege_type, e.is_grantable
        from aclexplode(array(select jsonb_array_elements_text(t.column_acls -> col))::aclitem[]) e
        where e.grantee = 0 or pg_get_userbyid(e.grantee) in ('anon', 'authenticated')
      loop
        execute format('grant %s (%I) on table public.%I to %s%s', g.privilege_type, col, t.table_name, g.grantee,
          case when g.is_grantable then ' with grant option' else '' end);
      end loop;
    end loop;
  end loop;
end $$;

-- default privileges: grant back only what 0006 removed — anon/authenticated/PUBLIC entries for tables and
-- sequences in schema public and global entries, and TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on tables in other
-- schemas (the same filter as 0006), for creators the current role may act for (0006 changed no others).
-- Nothing is revoked: other object types and schemas, and changes made after 0006, stay as they are.
do $$
declare
  g record;
begin
  for g in
    select s.* from app.default_acl_before_0006 s
    where pg_has_role(current_user, s.creator, 'MEMBER')
      and ((s.objtype in ('r', 'S') and (s.schema_name is null or s.schema_name = 'public'))
           or (s.objtype = 'r' and s.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')))
  loop
    execute format('alter default privileges for role %I %s grant %s on %s to %s%s',
      g.creator, case when g.schema_name is null then '' else format('in schema %I', g.schema_name) end,
      g.privilege_type, case g.objtype when 'r' then 'tables' else 'sequences' end,
      case when g.grantee = 'PUBLIC' then 'public' else quote_ident(g.grantee) end,
      case when g.is_grantable then ' with grant option' else '' end);
  end loop;
end $$;

drop table app.acl_before_0006;
drop table app.default_acl_before_0006;

-- the role helper is only used by the 0006 policies; the unsafe-defaults report only by 0006 itself
drop function app.current_user_role();
drop function app.unsafe_default_acls_0006();

-- forget 0006 in the same transaction, so the next migrate run re-applies it
do $$
declare
  n int;
begin
  delete from drizzle.__drizzle_migrations where created_at = 1792242997447 and hash = 'b267f0f08c0bb41e13ea8f891be022ebc21c405813522ccd4a3afe8c81e01e9b';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'rollback 0006: expected to remove one 0006 row, removed %', n;
  end if;
end $$;

commit;
