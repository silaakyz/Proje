/**
 * Creates (or updates) the least-privilege login role the application uses in production, so the app does not run
 * as the database superuser that owns the schema and runs migrations.
 *
 *   APP_DB_USER (default eip_app) / APP_DB_PASSWORD  →  node scripts/db/app-role.mjs   (npm run db:app-role)
 *
 * Connects with DIRECT_URL (or DATABASE_URL) as the migration role (owner / superuser). Run it after every
 * `npm run drizzle:migrate`: it is idempotent and grants on all current tables, so tables added by later migrations
 * are covered too (docker-compose.prod.yml does both in the `migrate` service).
 *
 * The role gets:
 *   - LOGIN, BYPASSRLS (the server-side `adminDb` connection works across tenants; every query is scoped in code),
 *     NOSUPERUSER NOCREATEDB NOCREATEROLE — no DDL, no role or database changes, no server-side file or program access;
 *   - membership in `authenticated`, so withRls (src/db/rls.ts) can switch into it for queries under RLS;
 *   - SELECT / INSERT / UPDATE / DELETE on the tables, sequence use and function execution in the app's schemas.
 * Creating a BYPASSRLS role needs a superuser; some managed PostgreSQL services do not allow it (docs/canliya-alma.md).
 */
import { makeRedactor } from "./redact.mjs";

const { config: loadEnv } = await import("dotenv");
loadEnv({ quiet: true });

const url = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
const user = process.env.APP_DB_USER?.trim() || "eip_app";
const password = process.env.APP_DB_PASSWORD ?? "";

const fail = (m) => { console.error(`db:app-role — ${m}`); process.exit(1); };
if (!url) fail("DIRECT_URL or DATABASE_URL (the migration role) is not set.");
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user)) fail("APP_DB_USER must be a plain lower-case name (letters, digits, _).");
if (password.length < 16) fail("APP_DB_PASSWORD must be at least 16 characters (use e.g. `openssl rand -hex 32`).");

const redact = makeRedactor(url, { ...process.env, PGPASSWORD: password });
const SCHEMAS = ["public", "auth", "app_private", "extensions"];

const pg = (await import("pg")).default;
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const { rows: [me] } = await client.query("select current_user as name, (select rolsuper from pg_roles where rolname = current_user) as su");
  if (me.name === user) fail(`connect as the migration role, not as ${user}.`);
  await client.query("begin");
  const ident = (await client.query("select quote_ident($1) as i, quote_literal($2) as p", [user, password])).rows[0];
  const exists = (await client.query("select 1 from pg_roles where rolname = $1", [user])).rowCount > 0;
  const attrs = `login bypassrls nosuperuser nocreatedb nocreaterole noinherit password ${ident.p}`;
  await client.query(`${exists ? "alter" : "create"} role ${ident.i} with ${attrs}`);
  await client.query(`grant authenticated to ${ident.i}`);
  const db = (await client.query("select quote_ident(current_database()) as d")).rows[0].d;
  await client.query(`grant connect on database ${db} to ${ident.i}`);
  const present = (await client.query("select nspname from pg_namespace where nspname = any($1)", [SCHEMAS])).rows.map((r) => r.nspname);
  for (const s of present) {
    const q = (await client.query("select quote_ident($1) as s", [s])).rows[0].s;
    await client.query(`grant usage on schema ${q} to ${ident.i}`);
    await client.query(`grant select, insert, update, delete on all tables in schema ${q} to ${ident.i}`);
    await client.query(`grant usage, select, update on all sequences in schema ${q} to ${ident.i}`);
    await client.query(`grant execute on all functions in schema ${q} to ${ident.i}`);
  }
  await client.query(`alter role ${ident.i} set search_path to "$user", public, extensions`);
  await client.query("commit");
  console.log(`db:app-role — ${exists ? "updated" : "created"} ${user} (grants on ${present.join(", ")})${me.su ? "" : " — note: the migration role is not a superuser"}`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`db:app-role — failed: ${redact(e?.message ?? e)}`);
  if (/bypassrls|permission denied to (create|alter) role|must be superuser/i.test(String(e?.message))) {
    console.error("The migration role must be a superuser to create a BYPASSRLS role (see docs/canliya-alma.md).");
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
