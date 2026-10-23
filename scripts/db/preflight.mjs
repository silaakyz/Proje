/**
 * READ-ONLY preflight for applying scripts/db/bootstrap.sql and drizzle/ to a real PostgreSQL. Changes nothing:
 * one connection, one `BEGIN READ ONLY` transaction, catalog queries only, then ROLLBACK.
 *
 * Reports: server version and role, whether bootstrap.sql can create what it needs (roles, pgvector, auth and
 * app_private schemas) or finds it already in place, what already
 * exists in `public` (name clashes, Prisma-era tables, `_prisma_migrations`), the state of
 * drizzle.__drizzle_migrations compared with the local journal and file hashes (which migrations are
 * pending, any hash mismatch), and the two conditions under which 0006_access_hardening is known to stop
 * (default privileges it cannot change, browser roles that can switch roles). Exit code 0 = no blocker
 * found, 2 = blocker(s) found, 1 = could not check.
 *
 * Usage: npm run db:preflight            (reads DIRECT_URL, else DATABASE_URL, from the environment / .env)
 * The connection URL and password are never printed (scripts/db/redact.mjs).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRedactor } from "./redact.mjs";

const { config: loadEnv } = await import("dotenv");
loadEnv({ quiet: true });

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("preflight: set DIRECT_URL (or DATABASE_URL) in .env");
  process.exit(1);
}
const redact = makeRedactor(url);
const pg = (await import("pg")).default;

const OUR_TABLES = ["organizations", "users", "events", "modules_registry", "attendees", "event_analytics_vectors", "ai_generations",
  "proposals", "tasks", "event_kpis", "surveys", "survey_questions", "survey_responses", "survey_response_spend", "multiplier_sets",
  "multipliers", "event_impact_inputs", "impact_calculation_runs"];
const PRISMA_ERA = ["organization_members", "profiles", "ai_action_proposals", "ticket_types", "form_fields", "check_ins", "event_days"];

const blockers = [];
const warnings = [];
const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
try {
  await client.connect();
} catch (e) {
  console.error(`preflight: cannot connect: ${redact(String(e?.message ?? e))}`);
  if (/ECONNREFUSED/i.test(String(e?.code ?? e?.message)))
    console.error("  Nothing listens at that host/port. Is PostgreSQL running (e.g. `docker compose up -d db`)?");
  process.exit(1);
}

try {
  await client.query("begin transaction read only");
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;

  console.log("Server");
  const s = await one(`select current_setting('server_version') v, current_setting('server_version_num')::int n, current_user u,
    (select rolsuper from pg_roles where rolname = current_user) su, current_database() db,
    has_database_privilege(current_user, current_database(), 'CREATE') can_create_schema`);
  line("version", s.v);
  line("connected as", `${s.u}${s.su ? " (superuser)" : ""} on ${s.db}`);
  if (s.n < 150000) blockers.push(`PostgreSQL ${s.v}: the migrations use column-scoped ON DELETE SET NULL (needs 15+)`);
  if (!s.can_create_schema) blockers.push(`${s.u} cannot create schemas (app, drizzle) in ${s.db}`);

  console.log("Platform prerequisites (scripts/db/bootstrap.sql creates what is missing)");
  const me = await one(`select rolsuper su, rolcreaterole cr from pg_roles where rolname = current_user`);
  const roles = (await all(`select rolname from pg_roles where rolname = any($1)`, [["anon", "authenticated", "service_role"]])).map((r) => r.rolname);
  line("roles", roles.sort().join(", ") || "(none yet)");
  const missingRoles = ["anon", "authenticated", "service_role"].filter((r) => !roles.includes(r));
  if (missingRoles.length && !me.su && !me.cr)
    blockers.push(`roles ${missingRoles.join(", ")} are missing and ${s.u} may not create roles (needs CREATEROLE or superuser; or create them once as a superuser)`);
  const canSwitch = roles.includes("authenticated") ? (await one(`select pg_has_role(current_user, 'authenticated', 'MEMBER') x`)).x : null;
  line("can SET ROLE authenticated", canSwitch === null ? "(granted by bootstrap)" : String(canSwitch));
  if (canSwitch === false && !me.su && !me.cr)
    blockers.push(`${s.u} is not a member of role authenticated and cannot grant it to itself (RLS queries run SET ROLE authenticated)`);
  const auth = await one(`select to_regclass('auth.users') is not null users, to_regclass('auth.sessions') is not null sessions,
    to_regprocedure('auth.uid()') is not null uid, to_regclass('app_private.rate_limits') is not null limits`);
  line("auth.users / sessions / uid()", `${auth.users} / ${auth.sessions} / ${auth.uid}`);
  line("app_private.rate_limits", String(auth.limits));
  const vec = await one(`select (select default_version from pg_available_extensions where name = 'vector') available,
    (select bool_or(trusted) from pg_available_extension_versions where name = 'vector') trusted,
    (select extversion || ' in ' || n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector') installed`);
  line("pgvector", `available ${vec.available ?? "no"}, installed ${vec.installed ?? "no"}`);
  if (!vec.installed && !vec.available) blockers.push("pgvector is not installed on the server (use the pgvector/pgvector:pg16 image or install the package)");
  else if (!vec.installed && !me.su && !vec.trusted) blockers.push(`pgvector is not created yet and ${s.u} is not a superuser (create it once: create extension vector with schema extensions)`);
  if (vec.installed && !vec.installed.endsWith(" in extensions")) warnings.push(`vector is installed in another schema (${vec.installed}); 0000 expects schema extensions`);

  console.log("Existing objects");
  const tables = (await all(`select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') order by 1`)).map((r) => r.t);
  line("public tables/views", tables.length ? tables.join(", ") : "(none)");
  if (tables.includes("_prisma_migrations")) blockers.push("public._prisma_migrations exists: a Prisma-era schema was applied here; do not run the Drizzle migrations on top of it");
  const prismaEra = tables.filter((t) => PRISMA_ERA.includes(t));
  if (prismaEra.length) blockers.push(`Prisma-era tables exist: ${prismaEra.join(", ")}`);
  const schemas = (await all(`select nspname from pg_namespace where nspname in ('app', 'drizzle', 'extensions', 'analytics')`)).map((r) => r.nspname);
  line("schemas", schemas.sort().join(", ") || "-");
  if (schemas.includes("analytics")) warnings.push("schema analytics exists (Prisma-era design); the Drizzle migrations do not use it");

  console.log("Drizzle migrations");
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  const local = journal.entries.map((e) => ({
    idx: e.idx, tag: e.tag, when: e.when,
    hash: createHash("sha256").update(readFileSync(join("drizzle", `${e.tag}.sql`))).digest("hex"),
  }));
  const hasTable = (await one(`select to_regclass('drizzle.__drizzle_migrations') is not null x`)).x;
  const applied = hasTable ? await all(`select id, hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at, id`) : [];
  const appliedByWhen = new Map(applied.map((r) => [String(r.created_at), r.hash]));
  const latest = applied.length ? Math.max(...applied.map((r) => Number(r.created_at))) : null;
  for (const m of local) {
    const h = appliedByWhen.get(String(m.when));
    const state = h === undefined ? (latest !== null && m.when <= latest ? "SKIPPED (older than the latest applied — the migrator would never apply it)" : "pending")
      : h === m.hash ? "applied" : "APPLIED WITH A DIFFERENT HASH";
    line(m.tag, state);
    if (state.startsWith("SKIPPED") || state.startsWith("APPLIED WITH")) blockers.push(`${m.tag}: ${state}`);
  }
  const unknown = applied.filter((r) => !local.some((m) => String(m.when) === String(r.created_at)));
  if (unknown.length) blockers.push(`${unknown.length} applied migration(s) are not in drizzle/ (another branch/repo migrated this database)`);
  if (!applied.length) {
    const clash = tables.filter((t) => OUR_TABLES.includes(t));
    if (clash.length) blockers.push(`no Drizzle history, but tables with our names exist: ${clash.join(", ")} (0001 would fail on them)`);
  }

  console.log("0006 access hardening (known stop conditions)");
  // Same selection as app.unsafe_default_acls_0006(); 0006 revokes the entries current_user may act for,
  // so the rows it cannot fix (or grants to a role anon/authenticated inherit) are what would stop it.
  const acl = await all(`
    select pg_get_userbyid(d.defaclrole) creator, coalesce(n.nspname, '<global>') scope, d.defaclobjtype::text objtype,
      case when e.grantee = 0 then 'PUBLIC' else pg_get_userbyid(e.grantee) end grantee,
      string_agg(e.privilege_type, ',' order by e.privilege_type) privs,
      pg_has_role(current_user, d.defaclrole, 'MEMBER') fixable,
      (e.grantee = 0 or pg_get_userbyid(e.grantee) in ('anon', 'authenticated')) direct
    from pg_default_acl d
    join pg_roles c on c.oid = d.defaclrole
    left join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) e
    where d.defaclobjtype in ('r', 'S') and (n.nspname is null or n.nspname = 'public')
      and (c.rolsuper or has_schema_privilege(c.oid, 'public', 'CREATE') or c.oid = (select nspowner from pg_namespace where nspname = 'public'))
      and case when e.grantee = 0 then true else pg_get_userbyid(e.grantee) in ('anon', 'authenticated')
        or pg_has_role('anon', e.grantee, 'USAGE') or pg_has_role('authenticated', e.grantee, 'USAGE') end
    group by d.defaclrole, n.nspname, d.defaclobjtype, e.grantee order by 1, 2, 3, 4`);
  const managed = acl.filter((r) => r.creator === "supabase_admin");
  const checked = acl.filter((r) => r.creator !== "supabase_admin");
  const stops = checked.filter((r) => !r.fixable || !r.direct);
  const revocable = checked.length - stops.length;

  line(
    "default-privilege entries",
    `${acl.length} found, ${revocable} 0006 can revoke, ` +
      `${managed.length ? `${managed.length} managed by supabase_admin (warning), ` : ""}${stops.length} blockers`
  );

  for (const r of managed) {
    line(
      "managed default",
      `${r.creator} ${r.scope} ${r.objtype === "r" ? "tables" : "sequences"} → ` +
        `${r.grantee}: ${r.privs}`
    );
  }

  if (managed.length) {
    warnings.push(
      "Supabase-managed supabase_admin default privileges cannot be changed by postgres. " +
      "They do not bypass RLS, but future public objects still need RLS and explicit grants. " +
      "Create application objects as postgres, not supabase_admin."
    );
  }

  for (const r of stops) {
    line(
      "",
      `${r.creator} ${r.scope} ${r.objtype === "r" ? "tables" : "sequences"} → ` +
        `${r.grantee}: ${r.privs}`
    );
    blockers.push(
      `0006 would stop: default privileges of ${r.creator} in ${r.scope} grant ` +
        `${r.grantee} ${r.privs} on new ${r.objtype === "r" ? "tables" : "sequences"} ` +
        `and ${s.u} cannot change them`
    );
  }
  const mode = s.n >= 160000 ? "SET" : "MEMBER";
  const sw = await all(`select b.rolname b, x.rolname x from pg_roles b cross join pg_roles x
    where b.rolname in ('anon', 'authenticated') and x.oid <> b.oid
      and (pg_has_role(b.oid, x.oid, '${mode}') or pg_has_role(b.oid, x.oid, 'MEMBER WITH ADMIN OPTION'))`);
  line("browser role switching", sw.length ? sw.map((r) => `${r.b} -> ${r.x}`).join(", ") : "none");
  if (sw.length) blockers.push(`0006 would stop: browser roles can switch roles (${sw.map((r) => `${r.b} -> ${r.x}`).join(", ")})`);

  await client.query("rollback");
} catch (e) {
  console.error(`preflight: query failed: ${redact(String(e?.message ?? e))}`);
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
  process.exit(1);
}
await client.end();

console.log("");
for (const w of warnings) console.log(`WARNING  ${w}`);
for (const b of blockers) console.log(`BLOCKER  ${b}`);
console.log(blockers.length ? `\n${blockers.length} blocker(s): do not migrate this database yet.` : "\nNo blocker found. Migrating is still a separate, explicit step (npm run drizzle:migrate runs bootstrap.sql, then the migrations).");
process.exit(blockers.length ? 2 : 0);
