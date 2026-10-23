/**
 * Real PostgreSQL 17 (PGlite, with pgvector) migrated by drizzle-orm's own migrator from ./drizzle,
 * then exercised through `withRls` — the exact code path the app uses. The platform prerequisites (auth schema,
 * RLS roles, auth.uid(), default privileges) come from scripts/db/bootstrap.sql, as on a real server.
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { withRls, type AppDatabase } from "@/db/rls";

const { organizations, users, events, modulesRegistry, attendees, eventAnalyticsVectors } = schema;

const ORG_A = "0a000000-0000-4000-8000-00000000000a";
const ORG_B = "0b000000-0000-4000-8000-00000000000b";
const U = {
  ownerA: "a0000000-0000-4000-8000-000000000001",
  staffA: "a0000000-0000-4000-8000-000000000002",
  ownerB: "b0000000-0000-4000-8000-000000000001",
  noProfile: "c0000000-0000-4000-8000-000000000001", // signed in, but no row in public.users
};
const vec = (hot: number) => `[${Array.from({ length: 1536 }, (_, i) => (i === hot ? 1 : 0)).join(",")}]`;

let pg: PGlite;
let db: AppDatabase; // superuser connection = adminDb in production (bypasses RLS)
const ids: Record<string, string> = {};

const as = <T>(userId: string, fn: Parameters<typeof withRls<T>>[2]) => withRls(db, { sub: userId }, fn);
const outcome = async (p: Promise<unknown>) => {
  try {
    const r = await p;
    return Array.isArray(r) ? r.length : "ok";
  } catch (e) {
    const err = e as { cause?: { message?: string }; message: string };
    return err.cause?.message ?? err.message;
  }
};

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
  await pg.exec(`alter database postgres set search_path to "$user", public, extensions; set search_path to "$user", public, extensions;`);
  db = drizzle({ client: pg, schema }) as unknown as AppDatabase;
  await migrate(drizzle({ client: pg }), { migrationsFolder: "drizzle" });

  for (const [name, id] of Object.entries(U)) await pg.query("insert into auth.users (id, email) values ($1, $2)", [id, `${name}@example.com`]);
  await db.insert(organizations).values([{ id: ORG_A, name: "Adana Belediyesi", subscriptionTier: "pro" }, { id: ORG_B, name: "Ajans B" }]);
  await db.insert(users).values([
    { id: U.ownerA, organizationId: ORG_A, email: "ownerA@example.com", role: "owner" },
    { id: U.staffA, organizationId: ORG_A, email: "staffA@example.com", role: "staff" },
    { id: U.ownerB, organizationId: ORG_B, email: "ownerB@example.com", role: "owner" },
  ]);
  for (const [org, tag] of [[ORG_A, "A"], [ORG_B, "B"]] as const) {
    const [ev] = await db.insert(events).values({ organizationId: org, title: `Event ${tag}`, status: "live", startDate: "2027-04-22", endDate: "2027-04-25" }).returning();
    ids[`event${tag}`] = ev!.id;
    await db.insert(modulesRegistry).values({ organizationId: org, eventId: ev!.id, moduleType: "stage", configuration: { stages: 2 } });
    const [at] = await db.insert(attendees).values({ organizationId: org, eventId: ev!.id, ticketType: "general" }).returning();
    ids[`attendee${tag}`] = at!.id;
    await db.insert(eventAnalyticsVectors).values({ organizationId: org, eventId: ev!.id, aiSummaryText: `Summary ${tag}`,
      embeddingModel: "test-embed", embedding: JSON.parse(vec(tag === "A" ? 0 : 1)) });
  }
});

describe("migrations", () => {
  it("drizzle migrator applied both migrations; every public table has RLS", async () => {
    const applied = await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(applied.rows[0]!.n).toBe(fs.readdirSync("drizzle").filter((f) => f.endsWith(".sql")).length);
    const open = await pg.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
    expect(open.rows).toEqual([]);
  });
  it("the HNSW index is used for similarity search", async () => {
    await pg.exec("set enable_seqscan = off");
    const plan = await pg.query<{ "QUERY PLAN": string }>(
      `explain select id from event_analytics_vectors order by embedding <=> $1::vector limit 5`, [vec(0)]);
    await pg.exec("reset enable_seqscan");
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/event_analytics_vectors_embedding_hnsw_idx/);
  });
});

describe("SELECT: each user sees exactly their organization", () => {
  const tables = { organizations, users, events, modulesRegistry, attendees, eventAnalyticsVectors };
  it.each(Object.keys(tables))("%s", async (name) => {
    const t = tables[name as keyof typeof tables];
    const orgCol = "organizationId" in t ? (t as typeof events).organizationId : organizations.id;
    const seenBy = async (u: string) => (await as(u, (tx) => tx.select({ org: orgCol }).from(t as typeof events))).map((r) => r.org);
    const a = await seenBy(U.ownerA);
    const b = await seenBy(U.ownerB);
    expect(a.length).toBeGreaterThan(0);
    expect(new Set(a)).toEqual(new Set([ORG_A]));
    expect(new Set(b)).toEqual(new Set([ORG_B]));
    expect(await seenBy(U.noProfile)).toEqual([]);
  });
  it("anon sees nothing", async () => {
    const r = await pg.transaction(async (tx) => {
      await tx.exec("set local role anon");
      return tx.query("select (select count(*) from events)::int + (select count(*) from users)::int as n");
    });
    expect(r.rows).toEqual([{ n: 0 }]);
    // 0006: anon has no privilege on attendees at all
    const att = await pg.transaction(async (tx) => {
      await tx.exec("set local role anon");
      return tx.query("select count(*) from attendees").then(() => "read", (e: Error) => e.message);
    });
    expect(att).toMatch(/permission denied/);
  });
});

describe("INSERT", () => {
  it("allowed into the caller's organization for owner/admin (0006: staff and attendees: see access-hardening)", async () => {
    expect(await outcome(as(U.ownerA, (tx) => tx.insert(events).values({ organizationId: ORG_A, title: "Yeni etkinlik" }).returning()))).toBe(1);
  });
  it("rejected for another organization (RLS)", async () => {
    expect(await outcome(as(U.ownerA, (tx) => tx.insert(events).values({ organizationId: ORG_B, title: "hijack" })))).toMatch(/row-level security/);
  });
  it("rejected when the row claims the caller's org but points at another tenant's event (composite FK)", async () => {
    expect(await outcome(as(U.ownerA, (tx) => tx.insert(modulesRegistry).values({ organizationId: ORG_A, eventId: ids.eventB!, moduleType: "booth" }))))
      .toMatch(/modules_registry_event_same_org_fk/);
  });
  it("browser roles cannot create users, organizations or analytics vectors (0006: no INSERT privilege)", async () => {
    expect(await outcome(as(U.ownerA, (tx) => tx.insert(users).values({ id: U.noProfile, organizationId: ORG_A, email: "x@example.com", role: "owner" })))).toMatch(/permission denied/);
    expect(await outcome(as(U.ownerA, (tx) => tx.insert(organizations).values({ name: "x" })))).toMatch(/permission denied/);
    expect(await outcome(as(U.ownerA, (tx) => tx.insert(eventAnalyticsVectors).values({ organizationId: ORG_A, eventId: ids.eventA!, aiSummaryText: "fake",
      embeddingModel: "m", embedding: JSON.parse(vec(2)), impactLevel: "economic_impact", netEconomicImpact: "99999999", impactMethodologyVersion: "x" })))).toMatch(/permission denied/);
  });
});

describe("UPDATE", () => {
  it("own rows: allowed for owner/admin", async () => {
    expect(await outcome(as(U.ownerA, (tx) => tx.update(events).set({ title: "Event A (güncel)" }).where(eq(events.id, ids.eventA!)).returning()))).toBe(1);
  });
  it("another tenant's rows: zero rows affected", async () => {
    expect(await outcome(as(U.ownerA, (tx) => tx.update(events).set({ title: "pwned" }).where(eq(events.id, ids.eventB!)).returning()))).toBe(0);
  });
  it("moving a row into another tenant is rejected (WITH CHECK / composite FK)", async () => {
    // 0006: organization_id is not even a writable column of events any more
    expect(await outcome(as(U.ownerA, (tx) => tx.update(events).set({ organizationId: ORG_B }).where(eq(events.id, ids.eventA!))))).toMatch(/permission denied|row-level security|violates foreign key/);
    const [m] = await db.insert(modulesRegistry).values({ organizationId: ORG_A, eventId: ids.eventA!, moduleType: "session" }).returning();
    // 0006: event_id is not a browser-writable column of modules_registry; server code is stopped by the composite FK
    expect(await outcome(as(U.ownerA, (tx) => tx.update(modulesRegistry).set({ eventId: ids.eventB! }).where(eq(modulesRegistry.id, m!.id)))))
      .toMatch(/permission denied/);
    expect(await outcome(db.update(modulesRegistry).set({ eventId: ids.eventB! }).where(eq(modulesRegistry.id, m!.id))))
      .toMatch(/modules_registry_event_same_org_fk/);
  });
  it("no privilege escalation: role, organization and subscription tier are not client-writable (0006: no UPDATE privilege)", async () => {
    expect(await outcome(as(U.staffA, (tx) => tx.update(users).set({ role: "owner" }).where(eq(users.id, U.staffA)).returning()))).toMatch(/permission denied/);
    expect(await outcome(as(U.ownerA, (tx) => tx.update(organizations).set({ subscriptionTier: "enterprise" }).returning()))).toMatch(/permission denied/);
    expect(await outcome(as(U.ownerA, (tx) => tx.update(eventAnalyticsVectors).set({ aiSummaryText: "edited" }).returning()))).toMatch(/permission denied/);
    expect((await db.select().from(users).where(eq(users.id, U.staffA)))[0]!.role).toBe("staff");
  });
});

describe("DELETE (no policy → server only)", () => {
  it("deletes nothing, even in the caller's own organization", async () => {
    // 0006: DELETE is not even granted on attendees, events or modules_registry
    expect(await outcome(as(U.ownerA, (tx) => tx.delete(attendees).returning()))).toMatch(/permission denied/);
    expect(await outcome(as(U.ownerA, (tx) => tx.delete(events).returning()))).toMatch(/permission denied/);
    expect(await outcome(as(U.ownerA, (tx) => tx.delete(modulesRegistry).returning()))).toMatch(/permission denied/);
    // 0006: nor on users (it had only Supabase's default privilege, closed by RLS alone)
    expect(await outcome(as(U.ownerA, (tx) => tx.delete(users).returning()))).toMatch(/permission denied/);
    expect(await outcome(as(U.ownerA, (tx) => tx.delete(organizations).returning()))).toMatch(/permission denied/);
    expect((await db.select().from(attendees)).length).toBe(2);
  });
});

describe("integrity even for RLS-bypassing server code", () => {
  it("a net economic impact cannot be stored without the economic_impact level and a methodology version", async () => {
    expect(await outcome(db.insert(eventAnalyticsVectors).values({ organizationId: ORG_A, eventId: ids.eventA!, aiSummaryText: "s",
      embeddingModel: "m", embedding: JSON.parse(vec(3)), netEconomicImpact: "1000000" }))).toMatch(/event_analytics_vectors_impact_requires_level/);
    expect(await outcome(db.insert(eventAnalyticsVectors).values({ organizationId: ORG_A, eventId: ids.eventA!, aiSummaryText: "s",
      embeddingModel: "m", embedding: JSON.parse(vec(3)), netEconomicImpact: "1000000", impactLevel: "economic_impact", impactMethodologyVersion: "impact/0.1" }))).toBe("ok");
  });
  it("check-in state is consistent", async () => {
    expect(await outcome(db.update(attendees).set({ isCheckedIn: true, checkedInAt: null }).where(eq(attendees.id, ids.attendeeB!)))).toMatch(/attendees_checkin_consistent/);
  });
});

describe("withRls", () => {
  it("settings are transaction-local: nothing leaks to the next query on the same connection", async () => {
    await as(U.ownerA, (tx) => tx.select().from(events));
    const r = await db.execute(sql`select current_user as u, coalesce(current_setting('request.jwt.claims', true), '') as c`);
    const row = (r as unknown as { rows: { u: string; c: string }[] }).rows[0]!;
    expect(row).toEqual({ u: "postgres", c: "" });
  });
  it("refuses a non-UUID subject", async () => {
    await expect(withRls(db, { sub: "' or 1=1 --" }, async () => 1)).rejects.toThrow(/must be a user UUID/);
  });
});
