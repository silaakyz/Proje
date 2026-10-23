/**
 * Database access for the Next.js server (Vercel). Two entry points, deliberately named apart:
 *
 *   getUserDb()  — the default for request handlers. Verifies the caller's session (auth.sessions,
 *                  src/db/sessions.ts) and runs every query under RLS as that user (`withRls`).
 *   adminDb      — RLS-BYPASSING connection (the login role of DATABASE_URL, which owns the tables).
 *                  Only for sessions, migrations, background jobs and server-side writes the policies
 *                  intentionally forbid (e.g. writing analytics vectors). Never call it with tenant
 *                  input you have not authorised.
 *
 * Driver: postgres-js against any PostgreSQL 15+ server prepared by scripts/db/bootstrap.sql.
 * `prepare: false` keeps it compatible with transaction-mode poolers (PgBouncer) in front of it.
 */
import "server-only";
import { cookies, headers } from "next/headers";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { withRls, type AppDatabase, type AppTransaction, type VerifiedClaims } from "./rls";
import { findSessionUser, SESSION_COOKIE, sessionTokenFrom } from "./sessions";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";

export const MISSING_DATABASE_URL =
  "DATABASE_URL is not set (postgres://user:password@host:5432/database, see .env.example). The database is used only at request time; the build does not need it.";

type AdminDatabase = ReturnType<typeof createDatabase>;

function createDatabase(url: string) {
  // One client per server instance; survives hot reload in dev. postgres-js opens sockets on the
  // first query, not here.
  const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };
  const client =
    globalForDb.pgClient ??
    postgres(url, {
      prepare: false, // works behind transaction-mode poolers (PgBouncer) too
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idle_timeout: 20,
      connect_timeout: 10,
    });
  if (process.env.NODE_ENV !== "production") globalForDb.pgClient = client;
  return drizzle({ client, schema, casing: "snake_case" });
}
/**
 * Offline PGlite database under .local/eip-db (work in progress: not wired into adminDb yet; it still needs
 * the migrations applied and auth.users rows for signed-in users). Exported so it can be wired explicitly.
 */
export function createLocalDatabase(): AdminDatabase {
  const globalForLocalDb = globalThis as unknown as {
    pgliteClient?: PGlite;
  };

  const client =
    globalForLocalDb.pgliteClient ??
    new PGlite(
      path.resolve(process.cwd(), ".local", "eip-db"),
      { extensions: { vector } },
    );

  if (process.env.NODE_ENV !== "production") {
    globalForLocalDb.pgliteClient = client;
  }

  return drizzlePglite({
    client,
    schema,
    casing: "snake_case",
  }) as unknown as AdminDatabase;
}

let instance: AdminDatabase | undefined;
/**
 * Created on first use, not at import: `next build` loads route modules to collect their config and
 * must work without DATABASE_URL. A missing URL is reported when the database is first used.
 */
function database(): AdminDatabase {
  if (instance) return instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(MISSING_DATABASE_URL);
  return (instance = createDatabase(url));
}

/** RLS-BYPASSING. See header comment. Lazily initialised (see `database()`). */
export const adminDb: AdminDatabase = new Proxy({} as AdminDatabase, {
  get(_target, prop) {
    const db = database();
    const value = Reflect.get(db, prop, db) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(db) : value;
  },
  has: (_target, prop) => Reflect.has(database(), prop),
});

export class UnauthenticatedError extends Error {
  override name = "UnauthenticatedError";
}

/**
 * Returns a runner bound to the verified caller. Every call opens one transaction under RLS:
 *   const userDb = await getUserDb();
 *   const rows = await userDb((tx) => tx.select().from(events));
 */
export async function getUserDb(): Promise<<T>(fn: (tx: AppTransaction) => Promise<T>) => Promise<T>> {
  const claims = await getVerifiedClaims();
  return (fn) => withRls(adminDb as AppDatabase, claims, fn);
}

/**
 * The signed-in caller (sub = user id, email). For flows that run before the caller has an app profile
 * (onboarding, /api/me); everything else should use getUserDb(). The session token comes from
 * `Authorization: Bearer <token>` (door scanner, curl) or the httpOnly session cookie (browsers) and is
 * checked against auth.sessions on every request — a signed-out or expired session is rejected at once.
 */
export async function getVerifiedClaims(): Promise<VerifiedClaims> {
  const token = sessionTokenFrom((await requestHeaders())?.get("authorization"), await sessionCookie());
  const user = await findSessionUser(adminDb as unknown as AppDatabase, token);
  if (!user) throw new UnauthenticatedError("Not signed in");
  return { sub: user.id, email: user.email, role: "authenticated" };
}

async function sessionCookie() {
  try {
    return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/** The request's headers, or null outside a request scope (background work, scripts, unit tests). */
async function requestHeaders() {
  try {
    return await headers();
  } catch {
    return null;
  }
}

export { schema };
