/**
 * Applies the Drizzle migrations — the same engine `drizzle-kit migrate` runs, plus a readable error.
 *
 * Why this exists: drizzle-kit 0.31.11 runs the migrator inside its progress spinner
 * (hanji renderWithTask). When a migration fails, the spinner catches the error, redraws
 * "[⣷] applying migrations..." and calls process.exit(1) — the PostgreSQL error is never printed,
 * so an operator cannot see e.g. why 0006_access_hardening stopped.
 *
 * What is identical to `drizzle-kit migrate` (drizzle-kit 0.31.11, postgresql dialect, url credentials,
 * `pg` installed — verified side by side against a local PostgreSQL 16.15):
 *   - environment: `.env` in the working directory is loaded first without overriding set variables.
 *     drizzle-kit bundles dotenv 16.5.0; this script uses the project's dotenv (18.x) with quiet: true
 *     (only the "injected env" log line is suppressed). Both were compared on the same .env fixture
 *     (tests/db/migrate-script.test.ts): quotes, spaces, comments, escapes, multi-line values, `export`,
 *     duplicates, CRLF, no expansion, pre-set and empty pre-set variables, DOTENV_CONFIG_PATH and
 *     DOTENV_CONFIG_OVERRIDE — identical results. Not supported here: drizzle-kit's
 *     `dotenv_config_*=` command-line arguments. Note for operators (both tools): an UNQUOTED `#`
 *     starts a comment, so a DIRECT_URL whose password contains `#` must be quoted in .env;
 *   - config: the same drizzle config file (default ./drizzle.config.ts): `out`, `migrations.table`,
 *     `migrations.schema`, `dbCredentials.url`;
 *   - connection: new pg.Pool({ connectionString: url, max: 1 }) wrapped by drizzle-orm/node-postgres;
 *   - migration: drizzle-orm/node-postgres/migrator `migrate(db, { migrationsFolder, migrationsTable,
 *     migrationsSchema })` — discovery from meta/_journal.json, hashes, created_at, the single
 *     transaction and the drizzle.__drizzle_migrations rows all come from that one function.
 * Only the error output differs (scripts/db/failure.mjs): SQLSTATE, message, detail, hint and context of
 * the failing statement — and, when the error is not a statement the database rejected (e.g. the
 * connection was lost during COMMIT), an explicit "outcome unknown" with the read-only query to check.
 * The connection URL and its password are removed from everything printed.
 *
 * Before the migrations it runs scripts/db/bootstrap.sql (idempotent): the platform prerequisites of the schema
 * on a plain PostgreSQL server — pgvector, the RLS roles, the auth/app_private tables and auth.uid(). A failure
 * there is reported the same way, prefixed "bootstrap"; no migration has run at that point.
 *
 * Usage: node scripts/db/migrate.mjs [--config <path>]     (npm run drizzle:migrate)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeFailure } from "./failure.mjs";
import { makeRedactor } from "./redact.mjs";

const args = process.argv.slice(2);
const configArg = args.find((a) => a.startsWith("--config="))?.slice("--config=".length)
  ?? (args.includes("--config") ? args[args.indexOf("--config") + 1] : undefined);
const configPath = resolve(configArg ?? "drizzle.config.ts");

// drizzle-kit loads .env (dotenv/config, no override) before it reads the config file.
const { config: loadEnv } = await import("dotenv");
loadEnv({ quiet: true });

const config = (await import(pathToFileURL(configPath).href)).default;
const url = config?.dbCredentials?.url;
if (config?.dialect !== "postgresql" || typeof url !== "string" || url === "") {
  console.error(`migrate: ${configPath} must use dialect "postgresql" and dbCredentials.url (is the URL variable set?)`);
  process.exit(1);
}

/** Everything printed goes through this: no URL, password or PGPASSWORD (scripts/db/redact.mjs). */
const redact = makeRedactor(url);

// `pg` is an explicit devDependency (as is drizzle-kit): migrations run where dev dependencies are installed.
const pg = await import("pg").then((m) => m.default, (e) => {
  if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
  console.error("migrate: the 'pg' package is not installed. Install the project's dev dependencies (npm ci) and re-run.");
  process.exit(1);
});
const { drizzle } = await import("drizzle-orm/node-postgres");
const { migrate } = await import("drizzle-orm/node-postgres/migrator");

const migrationsFolder = config.out ?? "drizzle";
const client = new pg.Pool({ connectionString: url, max: 1 });
// A lost connection emits 'error' on the pool (idle client) or on the checked-out client that runs the
// migration transaction. Without listeners Node crashes with an unredacted stack trace and the
// classification below is never printed; with them, the running query fails and the catch reports it.
const onConnectionError = (err) => console.error(redact(`migrate: connection error: ${err?.message ?? err}`));
client.on("error", onConnectionError);
client.on("connect", (c) => c.on("error", onConnectionError));
const db = drizzle(client);

const bootstrapSql = readFileSync(fileURLToPath(new URL("./bootstrap.sql", import.meta.url)), "utf8");
let stage = "bootstrap";
try {
  console.log("migrate: bootstrap (scripts/db/bootstrap.sql)");
  await client.query(bootstrapSql);
  stage = "migrations";
  console.log(`migrate: applying pending migrations from ${migrationsFolder}`);
  await migrate(db, {
    migrationsFolder,
    migrationsTable: config.migrations?.table,
    migrationsSchema: config.migrations?.schema,
  });
  console.log("migrate: migrations applied successfully");
  await client.end();
  process.exit(0);
} catch (e) {
  const lines = describeFailure(e, { migrationsSchema: config.migrations?.schema, migrationsTable: config.migrations?.table });
  if (stage === "bootstrap") {
    // Nothing of the migrations ran yet; bootstrap.sql is idempotent and can simply be re-run once fixed.
    const details = lines.findIndex((l) => /^ {2}(sqlstate|code|severity|error)/.test(l));
    lines.splice(0, details, "migrate: FAILED during bootstrap (scripts/db/bootstrap.sql) — no migration was run; fix the cause and re-run.");
  }
  console.error(redact(lines.join("\n")));
  await client.end().catch(() => {});
  process.exit(1);
}
