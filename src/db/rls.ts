/**
 * Runs Drizzle queries under Row Level Security: inside one transaction, as role `authenticated`, with
 * the caller's claims available to auth.uid() (scripts/db/bootstrap.sql). Without this, Drizzle runs as
 * the table owner and RLS is bypassed entirely.
 *
 * Driver-agnostic (postgres-js in the app, PGlite in tests). `set_config(..., true)` is transaction-
 * local, so this is safe behind a transaction pooler too: nothing leaks to the next client.
 */
import { sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

export type Schema = typeof schema;
type Relations = ExtractTablesWithRelations<Schema>;
export type AppDatabase = PgDatabase<PgQueryResultHKT, Schema, Relations>;
export type AppTransaction = PgTransaction<PgQueryResultHKT, Schema, Relations>;

/** Claims that have ALREADY been verified (getVerifiedClaims: a valid session). Never pass unverified input. */
export interface VerifiedClaims {
  sub: string;
  role?: string;
  [claim: string]: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function withRls<T>(db: AppDatabase, claims: VerifiedClaims, fn: (tx: AppTransaction) => Promise<T>): Promise<T> {
  if (!UUID.test(claims.sub)) throw new Error("withRls: claims.sub must be a user UUID");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('request.jwt.claims', ${JSON.stringify({ ...claims, role: "authenticated" })}, true),
      set_config('request.jwt.claim.sub', ${claims.sub}, true),
      set_config('role', 'authenticated', true)`);
    return fn(tx);
  });
}
