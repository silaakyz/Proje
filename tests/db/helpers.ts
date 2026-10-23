import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import { withRls, type AppDatabase } from "@/db/rls";

export const ORG_A = "0a000000-0000-4000-8000-00000000000a";
export const ORG_B = "0b000000-0000-4000-8000-00000000000b";
export const U = {
  ownerA: "a0000000-0000-4000-8000-000000000001",
  staffA: "a0000000-0000-4000-8000-000000000002",
  ownerB: "b0000000-0000-4000-8000-000000000001",
  noProfile: "c0000000-0000-4000-8000-000000000001",
};

/** Real PostgreSQL (PGlite + pgvector), prepared by scripts/db/bootstrap.sql, migrated by drizzle-orm's migrator. */
export async function setupDb() {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
  await pg.exec(`alter database postgres set search_path to "$user", public, extensions; set search_path to "$user", public, extensions;`);
  await migrate(drizzle({ client: pg }), { migrationsFolder: "drizzle" });
  const db = drizzle({ client: pg, schema }) as unknown as AppDatabase; // = adminDb (bypasses RLS)

  for (const [name, id] of Object.entries(U)) await pg.query("insert into auth.users (id, email) values ($1, $2)", [id, `${name}@example.com`]);
  await db.insert(schema.organizations).values([{ id: ORG_A, name: "Org A" }, { id: ORG_B, name: "Org B" }]);
  await db.insert(schema.users).values([
    { id: U.ownerA, organizationId: ORG_A, email: "ownerA@example.com", role: "owner" },
    { id: U.staffA, organizationId: ORG_A, email: "staffA@example.com", role: "staff" },
    { id: U.ownerB, organizationId: ORG_B, email: "ownerB@example.com", role: "owner" },
  ]);
  const as = <T>(userId: string, fn: Parameters<typeof withRls<T>>[2]) => withRls(db, { sub: userId }, fn);
  return { pg, db, as };
}

/** Resolves to row count, "ok", or the database error message. */
export async function outcome(p: Promise<unknown>) {
  try {
    const r = await p;
    return Array.isArray(r) ? r.length : "ok";
  } catch (e) {
    const err = e as { cause?: { message?: string }; message: string };
    return err.cause?.message ?? err.message;
  }
}

/** A copy of drizzle/ that stops at migration `maxIdx` (later SQL/snapshots removed, journal truncated). */
export function migrationsUpTo(maxIdx: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drizzle-upto-${maxIdx}-`));
  fs.cpSync("drizzle", dir, { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
  for (const e of journal.entries.filter((e: { idx: number }) => e.idx > maxIdx)) {
    fs.rmSync(path.join(dir, `${e.tag}.sql`));
    fs.rmSync(path.join(dir, `meta/${String(e.idx).padStart(4, "0")}_snapshot.json`));
  }
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= maxIdx);
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(journal));
  return dir;
}
