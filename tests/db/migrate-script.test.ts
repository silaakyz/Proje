/**
 * scripts/db/migrate.mjs (npm run drizzle:migrate) — the parts that need no database:
 *  - .env handling is identical to `drizzle-kit` (which bundles its own dotenv 16.5.0; the script uses
 *    the project's dotenv): both commands load the same config file, which records what they saw;
 *  - a failed run exits 1 with the error code and message, and never prints the password or the URL.
 * Migration equivalence, rollback on failure and re-runs need a real PostgreSQL server (the migrator
 * uses the `pg` driver) and were run against a local PostgreSQL 16.15 — see the step report.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM helper without type declarations
import { makeRedactor } from "../../scripts/db/redact.mjs";
// @ts-expect-error plain ESM helper without type declarations
import { describeFailure } from "../../scripts/db/failure.mjs";
import pg from "pg";

const ROOT = resolve(__dirname, "../..");
const SCRIPT = join(ROOT, "scripts/db/migrate.mjs");
// drizzle-kit's own JS entry, run with this Node binary: node_modules/.bin/drizzle-kit is a shell script
// on Linux and a .cmd shim on Windows (which spawnSync cannot run without a shell), so neither is portable.
const KIT_DIR = join(ROOT, "node_modules", "drizzle-kit");
const KIT = join(KIT_DIR, (JSON.parse(readFileSync(join(KIT_DIR, "package.json"), "utf8")) as { bin: Record<string, string> }).bin["drizzle-kit"]!);

/** Environment without any database variables of the developer's shell. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(DATABASE_URL|DIRECT_URL|PG|E_|DOTENV_)/.test(k)) env[k] = v;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

const ENV_FILE = [
  "# comment line",
  "E_PLAIN=abc",
  "E_SPACES_AROUND = spaced value  ",
  'E_DQ="double quoted  # not a comment"',
  "E_SQ='single quoted \\n stays'",
  "E_BT=`backtick value`",
  'E_DQ_ESC="line1\\nline2"',
  "E_INLINE=value # trailing comment",
  "E_HASH_NOSPACE=a#b",
  "E_URL=postgres://u:p%40ss@h:5432/db?sslmode=require&x=1",
  'E_URL_HASH="postgres://u:p#ss@h:5432/db"',
  "E_EMPTY=",
  'E_EMPTY_DQ=""',
  "export E_EXPORTED=exp",
  "E_EXPAND=${E_PLAIN}-x",
  "E_DUP=first",
  "E_DUP=second",
  'E_MULTI="m1',
  'm2"',
  "E_PRESET=from-file",
  "E_PRESET_EMPTY=from-file",
  "E_NOEQ",
  "E_UNICODE=İstanbul ğüşöç",
  "E_TRAIL_TAB=tab\t",
].join("\n") + "\nE_CRLF=crlf\r\nE_AFTER_CRLF=\"q\"\r\n";

// Loaded by both commands after they have read .env; records every E_* variable and exports a config
// without a URL, so neither command connects anywhere.
const DUMP_CONFIG = `import { writeFileSync } from "node:fs";
const env = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("E_")).sort().map((k) => [k, process.env[k]]));
writeFileSync(process.env.DUMP_TO, JSON.stringify(env));
export default { dialect: "postgresql", schema: "./schema.ts", out: "./drizzle", dbCredentials: { url: "" } };
`;

describe("migrate script: .env handling equals drizzle-kit", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eip-env-"));
    writeFileSync(join(dir, ".env"), ENV_FILE);
    writeFileSync(join(dir, "alt.env"), "E_ALT=alt\nE_PRESET=alt-file\n");
    writeFileSync(join(dir, "dump.config.mjs"), DUMP_CONFIG);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function seenBy(tool: "kit" | "script", extra: Record<string, string>) {
    const out = join(dir, `${tool}.json`);
    rmSync(out, { force: true });
    const env = cleanEnv({ ...extra, DUMP_TO: out });
    const res = spawnSync(process.execPath, [tool === "kit" ? KIT : SCRIPT, tool === "kit" ? "check" : "", "--config=dump.config.mjs"].filter(Boolean),
      { cwd: dir, env, encoding: "utf8" });
    // the config file writes `out` when the tool loads it; if it did not, say why instead of failing on ENOENT
    if (!existsSync(out)) throw new Error(`${tool} did not load the config (status ${res.status}, error ${res.error?.message ?? "none"}):\n${res.stderr}${res.stdout}`);
    return { seen: JSON.parse(readFileSync(out, "utf8")) as Record<string, string>, res };
  }

  const cases: [string, Record<string, string>][] = [
    ["default .env, pre-set variables", { E_PRESET: "from-shell", E_PRESET_EMPTY: "" }],
    ["DOTENV_CONFIG_PATH", { E_PRESET: "from-shell", DOTENV_CONFIG_PATH: "alt.env" }],
    ["DOTENV_CONFIG_OVERRIDE", { E_PRESET: "from-shell", DOTENV_CONFIG_OVERRIDE: "true" }],
  ];
  it.each(cases)("%s: same variables and values", (_name, extra) => {
    const kit = seenBy("kit", extra);
    const script = seenBy("script", extra);
    expect(script.seen).toEqual(kit.seen);
    expect(script.res.status).toBe(1); // no URL in the dump config: refuses before connecting
    expect(script.res.stderr).toContain("must use dialect");
  }, 60_000);

  it("parses the fixture as documented (both tools)", () => {
    const { seen } = seenBy("script", { E_PRESET: "from-shell", E_PRESET_EMPTY: "" });
    expect(seen).toMatchObject({
      E_PLAIN: "abc", E_SPACES_AROUND: "spaced value", E_DQ: "double quoted  # not a comment",
      E_SQ: "single quoted \\n stays", E_BT: "backtick value", E_DQ_ESC: "line1\nline2", E_INLINE: "value",
      E_HASH_NOSPACE: "a", // unquoted # starts a comment: quote passwords that contain #
      E_URL: "postgres://u:p%40ss@h:5432/db?sslmode=require&x=1", E_URL_HASH: "postgres://u:p#ss@h:5432/db",
      E_EMPTY: "", E_EMPTY_DQ: "", E_EXPORTED: "exp", E_EXPAND: "${E_PLAIN}-x", E_DUP: "second",
      E_MULTI: "m1\nm2", E_UNICODE: "İstanbul ğüşöç", E_TRAIL_TAB: "tab", E_CRLF: "crlf", E_AFTER_CRLF: "q",
      E_PRESET: "from-shell", E_PRESET_EMPTY: "", // existing variables are never overwritten, even if empty
    });
    expect(seen).not.toHaveProperty("E_NOEQ");
  }, 60_000);
});

describe("migrate script: failure output", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eip-mig-"));
    writeFileSync(join(dir, "url.config.mjs"),
      `export default { dialect: "postgresql", out: ${JSON.stringify(join(ROOT, "drizzle"))}, dbCredentials: { url: process.env.TEST_URL } };\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (url: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, "--config=url.config.mjs"], { cwd: dir, env: cleanEnv({ TEST_URL: url, ...extra }), encoding: "utf8" });

  // Port 1 on loopback: nothing listens, so the connection is refused locally (no remote host involved).
  it.each([
    ["plain password", "postgres://svc_user:Plain-Secret-1@127.0.0.1:1/app", ["Plain-Secret-1"]],
    ["percent-encoded password", "postgres://svc_user:p%40ss-Secret-2@127.0.0.1:1/app?sslmode=disable", ["p%40ss-Secret-2", "p@ss-Secret-2"]],
    ["password via PGPASSWORD", "postgres://svc_user@127.0.0.1:1/app", ["Env-Secret-3"]],
  ])("%s: exit 1, error code shown, no secret printed", (_name, url, secrets) => {
    const res = run(url, { PGPASSWORD: "Env-Secret-3" });
    const output = res.stdout + res.stderr;
    expect(res.status).toBe(1);
    // The connection already fails in the bootstrap step, before any migration could start.
    expect(res.stderr).toContain("migrate: FAILED during bootstrap (scripts/db/bootstrap.sql) — no migration was run");
    expect(res.stderr).not.toContain("OUTCOME UNKNOWN");
    expect(res.stderr).toMatch(/code +: ECONNREFUSED/);
    expect(res.stderr).toContain("connect ECONNREFUSED 127.0.0.1:1");
    for (const s of secrets) expect(output).not.toContain(s);
    expect(output).not.toContain(url);
  }, 30_000);

  it("unparsable URL: no part of it is printed", () => {
    const res = run("postgres://svc_user:Bad-Secret-4@[::zz]/app");
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/code +: ERR_INVALID_URL/);
    expect(res.stdout + res.stderr).not.toContain("Bad-Secret-4");
  }, 30_000);
});

describe("redaction of everything the script prints", () => {
  const url = "postgresql://svc.ref:p%40ss%23Word-9@db.example.internal:5432/postgres?sslmode=require";
  const redact: (v: unknown) => string = makeRedactor(url, { PGPASSWORD: "Env-PW-7" });

  it("removes the URL, its password (raw and decoded), PGPASSWORD and credentials of other URLs", () => {
    const text = redact([
      `connect to ${url} failed`, "raw p%40ss%23Word-9 decoded p@ss#Word-9", "env Env-PW-7",
      "other postgres://bob:hunter2@other.host/db", 'role "svc.ref" denied',
    ].join("\n"));
    for (const s of [url, "p%40ss%23Word-9", "p@ss#Word-9", "Env-PW-7", "hunter2"]) expect(text).not.toContain(s);
    expect(text).toContain("connect to [redacted] failed");
    expect(text).toContain("postgres://[redacted]@other.host/db");
    expect(text).toContain('role "svc.ref" denied'); // ordinary diagnostics stay readable
  });

  it("keeps working for malformed escapes and unparsable URLs", () => {
    expect(makeRedactor("postgres://u:bad%zzSecret@h/db", {})("x bad%zzSecret y")).toBe("x [redacted] y");
    expect(makeRedactor("not a url Secret-5", {})("got not a url Secret-5")).toBe("got [redacted]");
  });
});

describe("failure classification: certain rollback vs unknown outcome", () => {
  type Lines = string[];
  const describe_ = describeFailure as (e: unknown, o?: object) => Lines;
  const dbError = (severity: string, code: string, message: string) => {
    const e = new pg.DatabaseError(message, 0, "error");
    Object.assign(e, { severity, code, where: "PL/pgSQL function inline_code_block line 22 at RAISE" });
    return e;
  };
  /** what drizzle-orm throws: the driver error as `cause`, the failed SQL as `query` */
  const wrapped = (cause: unknown) => Object.assign(new Error("Failed query: do $$ ..."), { cause, query: "do $$ declare bad text; begin ... end $$;", params: [] });

  it("a statement the database rejected (severity ERROR): none applied, SQLSTATE and context shown", () => {
    const out = describe_(wrapped(dbError("ERROR", "P0001", "0006: browser roles hold column privileges beyond the intended surface: x"))).join("\n");
    expect(out).toContain("the database rejected a statement; pending migrations run in one transaction, so none of them was applied or recorded");
    expect(out).toMatch(/sqlstate: P0001/);
    expect(out).toContain("severity: ERROR");
    expect(out).toContain("0006: browser roles hold column privileges beyond the intended surface: x");
    expect(out).toContain("where   : PL/pgSQL function inline_code_block line 22 at RAISE");
    expect(out).toContain("statement: do $$ declare bad text; begin ... end $$;");
    expect(out).not.toContain("OUTCOME UNKNOWN");
  });

  it.each([
    ["backend terminated (FATAL 57P01)", wrapped(dbError("FATAL", "57P01", "terminating connection due to administrator command"))],
    ["connection reset during COMMIT", wrapped(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))],
    ["connection ended unexpectedly", new Error("Connection terminated unexpectedly")],
    ["drizzle's ROLLBACK failing after the connection died", Object.assign(new Error("Failed query: rollback\nparams: "),
      { query: "rollback", params: [], cause: new Error("Connection terminated unexpectedly") })],
    ["timeout", Object.assign(new Error("Query read timeout"), { code: "ETIMEDOUT" })],
  ])("%s: outcome unknown, with the read-only check to run; the real cause is still shown", (_n, err) => {
    const out = describe_(err, { migrationsSchema: "drizzle", migrationsTable: "__drizzle_migrations" }).join("\n");
    expect(out).toContain("OUTCOME UNKNOWN");
    expect(out).toContain("may\n  or may not have been committed");
    expect(out).toContain('select id, hash, created_at from "drizzle"."__drizzle_migrations" order by id;');
    expect(out).not.toContain("none of them was applied");
    const cause = (err as { cause?: { message: string } }).cause?.message ?? (err as Error).message;
    expect(out).toContain(cause);
  });

  it("uses the configured migrations schema/table in the read-only check", () => {
    const out = describe_(new Error("x"), { migrationsSchema: "ops", migrationsTable: "applied" }).join("\n");
    expect(out).toContain('from "ops"."applied"');
  });
});

describe("drizzle.config.ts: database URL", () => {
  const load = async (env: Record<string, string | undefined>) => {
    const saved = { DIRECT_URL: process.env.DIRECT_URL, DATABASE_URL: process.env.DATABASE_URL };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    try {
      vi.resetModules();
      const mod = await import("../../drizzle.config");
      return (mod.default as { dbCredentials: { url: string } }).dbCredentials.url;
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  it("an empty DIRECT_URL (as in .env.example) falls back to DATABASE_URL", async () => {
    expect(await load({ DIRECT_URL: "", DATABASE_URL: "postgres://a@h/db" })).toBe("postgres://a@h/db");
    expect(await load({ DIRECT_URL: "postgres://d@h/db", DATABASE_URL: "postgres://a@h/db" })).toBe("postgres://d@h/db");
    expect(await load({ DIRECT_URL: undefined, DATABASE_URL: undefined })).toBe("");
  });
});
