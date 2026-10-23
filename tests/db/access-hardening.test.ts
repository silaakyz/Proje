/**
 * Migration 0006 (access hardening) on PGlite with the platform prerequisites of scripts/db/bootstrap.sql:
 *  - attendees: readable by owner/admin only, never writable from the browser, qr_uuid readable by no
 *    browser role;
 *  - events / modules_registry: INSERT/UPDATE by owner/admin only; events UPDATE limited to five
 *    columns and browser-created events carry no AI profile;
 *  - ORG_PERMISSIONS ↔ live policies parity; the new permissions are not used by any endpoint;
 *  - server (adminDb) flows unaffected; upgrade from 0005 keeps data; the manual rollback SQL restores
 *    the pre-0006 surface exactly (from the snapshot 0006 takes) and 0006 can be re-applied afterwards;
 *  - TRUNCATE is gone for browser roles (behaviour tested in security-surface.test.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { attendees, eventAnalyticsVectors, events, modulesRegistry, organizations, RLS_ROLES, users } from "@/db/schema";
import { ORG_A, ORG_B, migrationsUpTo, outcome, setupDb, U } from "./helpers";

const ADMIN_A = "a0000000-0000-4000-8000-000000000003";
const DOWN_SQL = "drizzle/rollback/0006_access_hardening.down.sql";
let ctx: Awaited<ReturnType<typeof setupDb>>;
const ids: Record<string, string> = {};
const qrOf: Record<string, string> = {};

beforeAll(async () => {
  ctx = await setupDb();
  await ctx.pg.query("insert into auth.users (id, email) values ($1, 'adminA@example.com')", [ADMIN_A]);
  await ctx.db.insert(users).values({ id: ADMIN_A, organizationId: ORG_A, email: "adminA@example.com", role: "admin" });
  for (const [org, tag] of [[ORG_A, "A"], [ORG_B, "B"]] as const) {
    const [ev] = await ctx.db.insert(events).values({ organizationId: org, title: `Event ${tag}` }).returning();
    ids[`event${tag}`] = ev!.id;
    const [at] = await ctx.db.insert(attendees).values({ organizationId: org, eventId: ev!.id, ticketType: "general" }).returning();
    ids[`attendee${tag}`] = at!.id;
    qrOf[tag] = at!.qrUuid;
    await ctx.db.insert(modulesRegistry).values({ organizationId: org, eventId: ev!.id, moduleType: "stage" });
  }
}, 60_000);

const anon = <T>(q: string) => ctx.pg.transaction(async (tx) => {
  await tx.exec("set local role anon");
  return tx.query<T>(q);
}).then((r) => r.rows, (e: Error) => e.message);

describe("attendees: read by owner/admin only", () => {
  const seen = (u: string) => ctx.as(u, (tx) => tx.select({ id: attendees.id, org: attendees.organizationId }).from(attendees));
  it("owner and admin of A see A's attendees; staff, outsiders and other tenants see none; anon has no privilege", async () => {
    expect((await seen(U.ownerA)).map((r) => r.id)).toEqual([ids.attendeeA]);
    expect((await seen(ADMIN_A)).map((r) => r.id)).toEqual([ids.attendeeA]);
    expect(await seen(U.staffA)).toEqual([]);
    expect(await seen(U.noProfile)).toEqual([]);
    expect((await seen(U.ownerB)).map((r) => r.id)).toEqual([ids.attendeeB]);
    expect(await anon("select id from attendees")).toMatch(/permission denied/);
  });

  it("qr_uuid is readable by no browser role (column privilege); the other columns are", async () => {
    for (const u of [U.ownerA, ADMIN_A, U.staffA]) {
      expect(await outcome(ctx.as(u, (tx) => tx.select({ qr: attendees.qrUuid }).from(attendees)))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.select().from(attendees)))).toMatch(/permission denied/); // select * as well
    }
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.select({
      id: attendees.id, organizationId: attendees.organizationId, eventId: attendees.eventId, ticketType: attendees.ticketType,
      isCheckedIn: attendees.isCheckedIn, checkedInAt: attendees.checkedInAt, createdAt: attendees.createdAt, updatedAt: attendees.updatedAt,
    }).from(attendees)))).toBe(1);
  });

  it("no browser role can insert, update or delete attendees; nothing changes", async () => {
    for (const u of [U.ownerA, ADMIN_A, U.staffA, U.ownerB]) {
      expect(await outcome(ctx.as(u, (tx) => tx.insert(attendees).values({ organizationId: ORG_A, eventId: ids.eventA!, ticketType: "vip" })))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.update(attendees).set({ isCheckedIn: true, checkedInAt: new Date() }).where(eq(attendees.id, ids.attendeeA!)))))
        .toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.update(attendees).set({ qrUuid: "0e000000-0000-4000-8000-00000000000e" }).where(eq(attendees.id, ids.attendeeA!)))))
        .toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.delete(attendees)))).toMatch(/permission denied/);
    }
    expect(await anon("insert into attendees (organization_id, event_id, ticket_type) values ('" + ORG_A + "', '" + ids.eventA + "', 'x')")).toMatch(/permission denied/);
    const rows = await ctx.db.select().from(attendees).orderBy(attendees.organizationId);
    expect(rows.map((r) => [r.id, r.qrUuid, r.isCheckedIn, r.ticketType])).toEqual([
      [ids.attendeeA, qrOf.A, false, "general"], [ids.attendeeB, qrOf.B, false, "general"],
    ]);
  });
});

describe("events: owner/admin write, limited columns, no AI profile from the browser", () => {
  it("owner and admin may create events in their own organization; staff, other tenants and anon may not", async () => {
    for (const u of [U.ownerA, ADMIN_A])
      expect(await outcome(ctx.as(u, (tx) => tx.insert(events).values({ organizationId: ORG_A, title: `by ${u.slice(-1)}` }).returning()))).toBe(1);
    expect(await outcome(ctx.as(U.staffA, (tx) => tx.insert(events).values({ organizationId: ORG_A, title: "staff" })))).toMatch(/row-level security/);
    expect(await outcome(ctx.as(U.ownerB, (tx) => tx.insert(events).values({ organizationId: ORG_A, title: "B in A" })))).toMatch(/row-level security/);
    expect(await outcome(ctx.as(U.noProfile, (tx) => tx.insert(events).values({ organizationId: ORG_A, title: "x" })))).toMatch(/row-level security/);
    expect(await anon(`insert into events (organization_id, title) values ('${ORG_A}', 'anon')`)).toMatch(/permission denied/);
  });

  it("a browser-created event cannot carry an AI profile", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.insert(events).values({ organizationId: ORG_A, title: "fake", aiConfig: { x: 1 }, aiConfigVersion: "blueprint/v1" }))))
      .toMatch(/row-level security/);
  });

  it("owner/admin update title, status and dates; staff updates nothing; other tenants update nothing", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(events).set({ title: "A (owner)", startDate: "2027-04-22", endDate: "2027-04-23" })
      .where(eq(events.id, ids.eventA!)).returning()))).toBe(1);
    expect(await outcome(ctx.as(ADMIN_A, (tx) => tx.update(events).set({ status: "live" }).where(eq(events.id, ids.eventA!)).returning()))).toBe(1);
    expect(await outcome(ctx.as(U.staffA, (tx) => tx.update(events).set({ title: "staff" }).where(eq(events.id, ids.eventA!)).returning()))).toBe(0);
    expect(await outcome(ctx.as(U.ownerB, (tx) => tx.update(events).set({ title: "B" }).where(eq(events.id, ids.eventA!)).returning()))).toBe(0);
    expect((await ctx.db.select().from(events).where(eq(events.id, ids.eventA!)))[0]).toMatchObject({ title: "A (owner)", status: "live" });
  });

  it("ai_config, ai_config_version and organization_id cannot be changed from the browser, not even by the owner", async () => {
    for (const set of [{ aiConfig: { x: 1 } }, { aiConfigVersion: "blueprint/v9" }, { organizationId: ORG_B }] as const)
      expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(events).set(set).where(eq(events.id, ids.eventA!))))).toMatch(/permission denied/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.delete(events).where(eq(events.id, ids.eventA!))))).toMatch(/permission denied/);
    expect(await anon(`update events set title = 'anon'`)).toMatch(/permission denied/);
  });

  it("server code (adminDb) still writes everything, including the AI profile", async () => {
    await ctx.db.update(events).set({ aiConfig: { event: {} }, aiConfigVersion: "blueprint/v1" }).where(eq(events.id, ids.eventA!));
    const [e] = await ctx.db.insert(events).values({ organizationId: ORG_A, title: "server", aiConfig: { a: 1 }, aiConfigVersion: "blueprint/v1" }).returning();
    expect(e).toMatchObject({ aiConfigVersion: "blueprint/v1" });
  });
});

describe("organizations, users, event_analytics_vectors: never browser-writable (0006)", () => {
  it("no role (owner, admin, staff, other tenant, anon) can insert, update or delete them; members still read their own", async () => {
    const vec = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
    for (const u of [U.ownerA, ADMIN_A, U.staffA, U.ownerB]) {
      expect(await outcome(ctx.as(u, (tx) => tx.insert(organizations).values({ name: "yeni" })))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.update(organizations).set({ name: "x" })))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.delete(organizations)))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.insert(users).values({ id: U.noProfile, organizationId: ORG_A, email: "n@example.com", role: "owner" }))))
        .toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.update(users).set({ role: "owner" })))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.delete(users)))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.insert(eventAnalyticsVectors).values({ organizationId: ORG_A, eventId: ids.eventA!, aiSummaryText: "x",
        embeddingModel: "m", embedding: JSON.parse(vec) })))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.update(eventAnalyticsVectors).set({ aiSummaryText: "x" })))).toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.delete(eventAnalyticsVectors)))).toMatch(/permission denied/);
    }
    for (const stmt of [`insert into organizations (name) values ('anon')`, `update users set role = 'owner'`, `delete from event_analytics_vectors`])
      expect(await anon(stmt)).toMatch(/permission denied/);
    // reads are unchanged (RLS-scoped); requireOrgPermission depends on reading users ⋈ organizations
    expect((await ctx.as(U.staffA, (tx) => tx.select({ id: users.id }).from(users))).length).toBe(3);
    expect((await ctx.as(U.staffA, (tx) => tx.select({ id: organizations.id }).from(organizations))).map((r) => r.id)).toEqual([ORG_A]);
    // server code (adminDb) still writes them
    await ctx.db.update(organizations).set({ name: "Org A" }).where(eq(organizations.id, ORG_A));
  });
});

describe("modules_registry: owner/admin write only", () => {
  it("owner and admin insert and update; staff and other tenants cannot; nobody deletes", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.insert(modulesRegistry).values({ organizationId: ORG_A, eventId: ids.eventA!, moduleType: "booth" }).returning()))).toBe(1);
    expect(await outcome(ctx.as(ADMIN_A, (tx) => tx.update(modulesRegistry).set({ configuration: { booths: 3 } })
      .where(eq(modulesRegistry.moduleType, "booth")).returning()))).toBe(1);
    expect(await outcome(ctx.as(U.staffA, (tx) => tx.insert(modulesRegistry).values({ organizationId: ORG_A, eventId: ids.eventA!, moduleType: "session" }))))
      .toMatch(/row-level security/);
    expect(await outcome(ctx.as(U.staffA, (tx) => tx.update(modulesRegistry).set({ configuration: { hacked: true } }).returning()))).toBe(0);
    expect(await outcome(ctx.as(U.ownerB, (tx) => tx.update(modulesRegistry).set({ configuration: {} }).where(eq(modulesRegistry.eventId, ids.eventA!)).returning()))).toBe(0);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.delete(modulesRegistry)))).toMatch(/permission denied/);
    // UPDATE is limited to configuration: module type, event and organization are not browser-writable
    for (const set of [{ moduleType: "session" as const }, { eventId: ids.eventB! }, { organizationId: ORG_B }])
      expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(modulesRegistry).set(set).where(eq(modulesRegistry.moduleType, "booth"))))).toMatch(/permission denied/);
    expect(await anon(`update modules_registry set configuration = '{}'`)).toMatch(/permission denied/);
    // staff can still read the organization's modules
    expect((await ctx.as(U.staffA, (tx) => tx.select({ id: modulesRegistry.id }).from(modulesRegistry))).length).toBe(2);
  });
});

describe("app.current_user_role()", () => {
  it("returns the caller's own role, NULL without a profile; SECURITY DEFINER, empty search_path, not for anon", async () => {
    const roleOf = async (u: string) =>
      ((await ctx.as(u, (tx) => tx.execute(sql`select app.current_user_role()::text as r`))) as unknown as { rows: { r: string | null }[] }).rows[0]!.r;
    expect(await roleOf(U.ownerA)).toBe("owner");
    expect(await roleOf(ADMIN_A)).toBe("admin");
    expect(await roleOf(U.staffA)).toBe("staff");
    expect(await roleOf(U.ownerB)).toBe("owner");
    expect(await roleOf(U.noProfile)).toBeNull();
    const { rows } = await ctx.pg.query(`select p.prosecdef as secdef, p.proconfig as config, has_function_privilege('anon', p.oid, 'EXECUTE') as anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'current_user_role'`);
    expect(rows).toEqual([{ secdef: true, config: ['search_path=""'], anon: false }]);
  });
});

describe("ORG_PERMISSIONS ↔ RLS parity", () => {
  const rolesIn = (expr: string | null) => {
    const m = expr?.match(/current_user_role\(\)[^']*\(([^)]*)\)/) ?? expr?.match(/IN\s*\(([^)]*)\)/i) ?? expr?.match(/ANY\s*\(\s*\(?ARRAY\[([^\]]*)\]/i);
    return m ? [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort() : null;
  };
  it("event.write = roles of events/modules_registry INSERT/UPDATE policies; attendee.read = roles of the attendees SELECT policy", async () => {
    const { ORG_PERMISSIONS } = await import("@/server/auth/org-access");
    const { rows } = await ctx.pg.query<{ t: string; n: string; q: string | null; w: string | null }>(
      "select tablename as t, policyname as n, qual as q, with_check as w from pg_policies where schemaname = 'public' and tablename in ('events','modules_registry','attendees')");
    const byName = Object.fromEntries(rows.map((r) => [r.n, r]));
    const write = [...ORG_PERMISSIONS["event.write"]].sort();
    for (const t of ["events", "modules_registry"]) {
      expect(rolesIn(byName[`${t}_insert_own_org`]!.w)).toEqual(write);
      expect(rolesIn(byName[`${t}_update_own_org`]!.q)).toEqual(write);
      expect(rolesIn(byName[`${t}_update_own_org`]!.w)).toEqual(write);
    }
    expect(rolesIn(byName.attendees_select_own_org!.q)).toEqual([...ORG_PERMISSIONS["attendee.read"]].sort());
    expect(Object.keys(byName).filter((n) => n.startsWith("attendees_"))).toEqual(["attendees_select_own_org"]);
    expect([...RLS_ROLES.eventWrite]).toEqual([...ORG_PERMISSIONS["event.write"]]);
    expect([...RLS_ROLES.attendeeRead]).toEqual([...ORG_PERMISSIONS["attendee.read"]]);
  });

  it("survey.manage = roles of the survey_responses / survey_response_spend SELECT policies (0007)", async () => {
    const { ORG_PERMISSIONS } = await import("@/server/auth/org-access");
    const { rows } = await ctx.pg.query<{ t: string; n: string; cmd: string; q: string | null }>(
      "select tablename as t, policyname as n, cmd, qual as q from pg_policies where schemaname = 'public' and tablename in ('survey_responses','survey_response_spend') order by 1, 2");
    const manage = [...ORG_PERMISSIONS["survey.manage"]].sort();
    expect(rows.map((r) => [r.t, r.n, r.cmd])).toEqual([
      ["survey_response_spend", "survey_response_spend_select_own_org", "SELECT"],
      ["survey_responses", "survey_responses_select_own_org", "SELECT"],
    ]);
    for (const r of rows) expect(rolesIn(r.q)).toEqual(manage);
    expect([...RLS_ROLES.surveyResponseRead]).toEqual([...ORG_PERMISSIONS["survey.manage"]]);
  });

  it("budget.read = roles of the budget_items SELECT policy, its only policy (0012)", async () => {
    const { ORG_PERMISSIONS } = await import("@/server/auth/org-access");
    const { rows } = await ctx.pg.query<{ n: string; cmd: string; q: string | null }>(
      "select policyname as n, cmd, qual as q from pg_policies where schemaname = 'public' and tablename = 'budget_items'");
    expect(rows.map((r) => [r.n, r.cmd])).toEqual([["budget_items_select_own_org", "SELECT"]]);
    expect(rolesIn(rows[0]!.q)).toEqual([...ORG_PERMISSIONS["budget.read"]].sort());
    expect([...RLS_ROLES.budgetRead]).toEqual([...ORG_PERMISSIONS["budget.read"]]);
  });

  it("every route uses exactly the permission it is documented with (route ↔ permission contract)", () => {
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }))
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === "route.ts" && routes.push(path.join(dir, e.name));
    };
    walk("src/app");
    const actual = Object.fromEntries(routes.sort().map((f) => [
      // POSIX separators on every OS (path.relative yields "events\\[eventId]" on Windows)
      path.relative("src/app/api", path.dirname(f)).split(path.sep).join("/"),
      [...new Set([...fs.readFileSync(f, "utf8").matchAll(/requireOrgPermission\([^,]+,\s*"([a-z_.]+)"\)/g)].map((m) => m[1]))].sort(),
    ]));
    expect(actual).toEqual({
      "ai/assistant": ["org.read"],
      "ai/blueprint": ["blueprint.generate"],
      "auth/options": [], // public: which sign-in features are on (no secrets)
      "auth/password-reset": [], // public: send a reset link (rate limited; silent for unknown addresses)
      "auth/password-reset/confirm": [], // public: the one-time token is the key
      "auth/sign-in": [], // public: email + password (rate limited)
      "auth/sign-out": [], // session only
      "auth/sign-up": [], // public: email + password (rate limited)
      "ai/blueprint/sections": ["blueprint.generate"],
      "ai/event-builder": ["blueprint.generate"],
      "ai/generations/[generationId]": ["org.read"],
      "budget-items/[itemId]": ["budget.manage"],
      "data-sources/[sourceId]": ["data.manage"],
      "datasets/[datasetId]": ["data.manage"],
      "datasets/[datasetId]/interpret": ["data.manage"],
      "events/[eventId]/datasets": ["data.manage", "org.read"],
      "events/[eventId]/report": ["org.read"], // budget section only with budget.read
      "events/[eventId]/registration-form": ["attendee.write"],
      "events/[eventId]/registrations": ["attendee.read"],
      "events/[eventId]/survey-link": ["survey.manage"],
      "mentions/[mentionId]": ["data.manage"],
      "events/[eventId]/data-sources": ["data.manage", "org.read"],
      "events/[eventId]/data-sources/pull": ["data.manage"],
      "events/[eventId]/mentions": ["data.manage", "org.read"],
      "events/[eventId]/uploads": ["data.manage"],
      "events/[eventId]/uploads/[kind]": ["data.manage"],
      "events": ["event.write", "org.read"],
      "events/[eventId]": ["event.write", "org.read"],
      "events/[eventId]/attendees": ["attendee.read", "attendee.write"],
      "events/[eventId]/attendees/[attendeeId]/qr": ["attendee.write"],
      "events/[eventId]/archive": ["event.write"],
      "events/[eventId]/attendees/cancel": ["attendee.write"],
      "events/[eventId]/attendees/export": ["attendee.read"],
      "events/[eventId]/budget": ["budget.manage", "budget.read"],
      "events/[eventId]/budget/export": ["budget.read"],
      "events/[eventId]/duplicate": ["event.write"],
      "events/[eventId]/checkin": ["checkin.perform"],
      "events/[eventId]/checkin/undo": ["attendee.write"],
      "events/[eventId]/checkins": ["checkin.perform"],
      "events/[eventId]/checkins/stream": ["checkin.perform"],
      "events/[eventId]/impact": ["org.read"],
      "events/[eventId]/impact/inputs": ["impact.manage", "org.read"],
      "events/[eventId]/impact/runs": ["impact.manage", "org.read"],
      "events/[eventId]/surveys": ["org.read"],
      "events/[eventId]/kpis": ["org.read"],
      "events/[eventId]/metrics": ["org.read"],
      "events/[eventId]/tasks": ["org.read"],
      "events/[eventId]/tickets": ["attendee.write"],
      "impact-runs/[runId]": ["org.read"],
      "kpis/[kpiId]": ["event.write"],
      "account/password": [], // session only: the caller's own password
      "account/sessions": [], // session only: the caller's own sessions
      "invitations/[token]": [], // public read by link holder; accepting needs a session (same address, no organization)
      "me": [], // session only: the caller's own profile
      "health": [], // public: 200/503 database probe for the container and proxy, no details
      "org": ["org.manage"],
      "org/invitations": ["member.manage"],
      "org/invitations/[invitationId]": ["member.manage"],
      "org/members": ["org.read"],
      "org/members/[userId]": ["member.manage", "org.read"], // DELETE: org.read (leaving); who may remove whom: team-service
      "multiplier-sets": ["impact.manage", "org.read"],
      "multiplier-sets/[setId]": ["impact.manage"],
      "multiplier-sets/from-io": ["impact.manage"],
      "io/tuik-2023": ["org.read"],
      "onboarding": [], // session only: creates the caller's organization
      "proposals": ["org.read"],
      "proposals/[proposalId]": ["proposal.decide"],
      "registrations/[registrationId]": ["attendee.write"],
      "public/registrations/[token]": [], // public: the KVKK registration form (rate limited)
      "public/tickets/[token]": [], // public: the ticket page; the QR token is the key
      "public/surveys/[token]": [], // public: no session; the survey's link token is the only key
      "public/surveys/[token]/responses": [], // public: anonymous submission to an OPEN survey
      "public/event-surveys/[token]": [], // public: the event's single link (role first, then that role's questions)
      "public/event-surveys/[token]/responses": [], // public: anonymous submission, stored on the chosen role's survey
      "survey-responses/[responseId]": ["survey.manage"],
      "surveys/[surveyId]": ["org.read", "survey.manage"],
      "surveys/[surveyId]/responses": ["survey.collect", "survey.manage"],
      "tasks/[taskId]": ["task.update_status"],
    });
  });
});

// ---------------------------------------------------------------------------
// Upgrade and rollback (fresh databases)
// ---------------------------------------------------------------------------

/** These tests are about 0006: they migrate exactly up to it, whatever later migrations exist. */
const UP_TO_0006 = migrationsUpTo(6);

async function freshAt(maxIdx: number) {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
  await pg.exec(`set search_path to "$user", public, extensions;`);
  await migrate(drizzle({ client: pg }), { migrationsFolder: migrationsUpTo(maxIdx) });
  return pg;
}

/** Policies, table/column privileges (as sorted ACL items) and the role helper: the browser surface. */
async function surface(pg: PGlite) {
  const q = async (s: string) => (await pg.query(s)).rows;
  return {
    policies: await q(`select tablename, policyname, cmd, permissive, roles::text, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`),
    tables: await q(`select c.relname, c.relkind::text, (select array_agg(x::text order by x::text) from unnest(c.relacl) x) acl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S') order by 1`),
    columns: await q(`select c.relname, a.attname, (select array_agg(x::text order by x::text) from unnest(a.attacl) x) acl
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and a.attacl is not null order by 1, 2`),
    roleFn: await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'current_user_role'`),
    // default privileges for future objects: creator role, scope (schema or global), object type, ACL
    defaults: await q(`select pg_get_userbyid(d.defaclrole) creator, coalesce(n.nspname, '<global>') scope, d.defaclobjtype::text objtype,
      (select array_agg(x::text order by x::text) from unnest(d.defaclacl) x) acl
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1, 2, 3`),
  };
}

describe("fail-closed check inside 0006", () => {
  it("aborts the whole migration if anon/authenticated would still hold a forbidden privilege via role membership", async () => {
    const pg = await freshAt(5);
    await pg.exec(`create role probe_member nologin; grant truncate on users to probe_member; grant probe_member to authenticated with inherit true, set false;`);
    const before = await surface(pg);
    const err = await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 }).then(() => "applied", (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message);
    expect(err).toMatch(/beyond the intended surface.*authenticated TRUNCATE on users/);
    expect((await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(6);
    expect(await surface(pg)).toEqual(before);
  });

  /** Applies 0006 to a 0005 database prepared with `setup`; returns the error (or "applied") and the state. */
  async function gate(setup: string) {
    const pg = await freshAt(5);
    await pg.exec(setup);
    const before = await surface(pg);
    const err = await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 })
      .then(() => "applied", (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message);
    const recorded = (await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n;
    return { pg, err, recorded, unchanged: JSON.stringify(await surface(pg)) === JSON.stringify(before) };
  }
  const colPriv = async (pg: PGlite, role: string, table: string, col: string, priv: string) =>
    (await pg.query<{ v: boolean }>("select has_column_privilege($1, $2, $3, $4) v", [role, `public.${table}`, col, priv])).rows[0]!.v;

  it("direct column grants of anon/authenticated on attendees.qr_uuid are removed by 0006 itself (no stop)", async () => {
    const { pg, err, recorded } = await gate(`grant select ("qr_uuid") on attendees to authenticated, anon;`);
    expect(err).toBe("applied");
    expect(recorded).toBe(7);
    for (const role of ["anon", "authenticated"]) expect(await colPriv(pg, role, "attendees", "qr_uuid", "SELECT")).toBe(false);
    expect(await colPriv(pg, "authenticated", "attendees", "ticket_type", "SELECT")).toBe(true); // the intended columns stay
  });

  it("attendees.qr_uuid readable through PUBLIC aborts the migration (0006 does not touch PUBLIC SELECT)", async () => {
    const r = await gate(`grant select ("qr_uuid") on attendees to public;`);
    expect(r.err).toMatch(/can read attendee columns beyond the intended surface.*anon SELECT \(qr_uuid\) on attendees; authenticated SELECT \(qr_uuid\) on attendees/);
    expect(r.recorded).toBe(6);
    expect(r.unchanged).toBe(true);
  });

  it("attendees.qr_uuid readable through an inherited role aborts the migration", async () => {
    const r = await gate(`create role probe_qr nologin; grant select ("qr_uuid") on attendees to probe_qr; grant probe_qr to authenticated with inherit true, set false;`);
    expect(r.err).toMatch(/can read attendee columns beyond the intended surface.*authenticated SELECT \(qr_uuid\) on attendees/);
    expect(r.err).not.toContain("anon SELECT");
    expect(r.recorded).toBe(6);
    expect(r.unchanged).toBe(true);
  });

  it("any attendee column readable by anon through an inherited role aborts the migration", async () => {
    const r = await gate(`create role probe_att nologin; grant select ("ticket_type") on attendees to probe_att; grant probe_att to anon with inherit true, set false;`);
    expect(r.err).toMatch(/anon SELECT \(ticket_type\) on attendees/);
    expect(r.recorded).toBe(6);
    expect(r.unchanged).toBe(true);
  });

  it("a column-level write through an inherited role aborts the migration (UPDATE users.role, REFERENCES)", async () => {
    const r = await gate(`create role probe_col nologin; grant update ("role") on users to probe_col;
      grant references ("id") on organizations to probe_col; grant probe_col to authenticated with inherit true, set false;`);
    expect(r.err).toMatch(/column privileges beyond the intended surface.*authenticated REFERENCES \(id\) on organizations; authenticated UPDATE \(role\) on users/);
    expect(r.recorded).toBe(6);
    expect(r.unchanged).toBe(true);
  });

  it("a column-level write beyond the intended columns via PUBLIC is removed by 0006 itself; a direct one too (no stop)", async () => {
    const { pg, err } = await gate(`grant update ("subscription_tier") on organizations to public;
      grant insert ("email") on users to public; grant update ("ai_config") on events to authenticated;`);
    expect(err).toBe("applied");
    expect(await colPriv(pg, "anon", "organizations", "subscription_tier", "UPDATE")).toBe(false);
    expect(await colPriv(pg, "authenticated", "users", "email", "INSERT")).toBe(false);
    expect(await colPriv(pg, "authenticated", "events", "ai_config", "UPDATE")).toBe(false);
    // the intended column surface is unchanged
    expect(await colPriv(pg, "authenticated", "tasks", "status", "UPDATE")).toBe(true);
    expect(await colPriv(pg, "authenticated", "events", "title", "UPDATE")).toBe(true);
    expect(await colPriv(pg, "authenticated", "modules_registry", "configuration", "UPDATE")).toBe(true);
  });

  it("checks MAINTAIN on PostgreSQL 17+ (PGlite): MAINTAIN via role membership aborts the migration", async () => {
    const pg = await freshAt(5);
    const version = (await pg.query<{ v: number }>("select current_setting('server_version_num')::int as v")).rows[0]!.v;
    expect(version).toBeGreaterThanOrEqual(170000); // this test covers the PG17+ branch only; PG16 was run on a real server
    await pg.exec(`create role probe_maint nologin; grant maintain on users to probe_maint; grant probe_maint to authenticated with inherit true, set false;`);
    const before = await surface(pg);
    const err = await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 }).then(() => "applied", (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message);
    expect(err).toMatch(/beyond the intended surface.*authenticated MAINTAIN on users/);
    expect((await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(6);
    expect(await surface(pg)).toEqual(before);
  });
});

describe("role switching (SET ROLE) inside 0006", () => {
  // These run on PGlite = PostgreSQL 17, i.e. the PostgreSQL 16+ branch ('SET'). The PostgreSQL 15 branch
  // ('MEMBER', CREATEROLE) is only checked statically below; no real PostgreSQL 15 server was used.
  async function gate(setup: string) {
    const pg = await freshAt(5);
    await pg.exec(setup);
    const before = await surface(pg);
    const err = await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 })
      .then(() => "applied", (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message);
    const recorded = (await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n;
    return { pg, err, recorded, unchanged: JSON.stringify(await surface(pg)) === JSON.stringify(before) };
  }
  /** Runs `sql` in a session whose session user is `role` (SET ROLE is checked against the session user). */
  async function asSession(pg: PGlite, role: string, sql: string) {
    try {
      await pg.exec(`set session authorization ${role}`);
      await pg.exec(sql);
      return (await pg.query<{ u: string }>("select current_user::text as u")).rows[0]!.u;
    } catch (e) {
      return `ERR ${(e as Error).message}`;
    } finally {
      await pg.exec("reset role; reset session authorization");
    }
  }
  const SWITCH = /browser roles can switch to other roles \(SET ROLE\), which this access policy does not allow: /;

  it("INHERIT FALSE, SET TRUE: the privilege is invisible to has_*_privilege but reachable by SET ROLE — the migration stops", async () => {
    const r = await gate(`create role probe_set nologin; create schema probe_s; create table probe_s.secret (x int);
      grant usage on schema probe_s to probe_set; grant select on probe_s.secret to probe_set;
      grant probe_set to authenticated with inherit false, set true;`);
    expect(r.err).toMatch(SWITCH);
    expect(r.err).toContain("authenticated -> probe_set (direct)");
    expect(r.recorded).toBe(6);
    expect(r.unchanged).toBe(true);
    // why the privilege checks alone are not enough: not inherited, yet usable after SET ROLE
    expect((await r.pg.query<{ v: boolean }>(`select has_table_privilege('authenticated', 'probe_s.secret', 'SELECT') v`)).rows[0]!.v).toBe(false);
    expect(await asSession(r.pg, "authenticated", "set role probe_set; select * from probe_s.secret")).toBe("probe_set");
    expect(await asSession(r.pg, "authenticated", "select * from probe_s.secret")).toMatch(/^ERR permission denied/);
  });

  it("direct and indirect paths are both reported (anon -> mid -> target, SET on every hop)", async () => {
    const r = await gate(`create role probe_mid nologin; create role probe_target nologin;
      grant probe_mid to anon with inherit false, set true; grant probe_target to probe_mid with inherit false, set true;`);
    expect(r.err).toMatch(SWITCH);
    expect(r.err).toContain("anon -> probe_mid (direct); anon -> probe_target (indirect)");
    expect(r.recorded).toBe(6);
    expect(r.unchanged).toBe(true);
    expect(await asSession(r.pg, "anon", "set role probe_target")).toBe("probe_target");
  });

  it("ADMIN OPTION without SET is a path too: the member can grant the role to itself", async () => {
    const r = await gate(`create role probe_admin nologin; grant probe_admin to authenticated with admin true, inherit false, set false;`);
    expect(r.err).toMatch(SWITCH);
    expect(r.err).toContain("authenticated -> probe_admin (direct, admin option)");
    expect(r.recorded).toBe(6);
    expect(r.unchanged).toBe(true);
    expect(await asSession(r.pg, "authenticated", "grant probe_admin to authenticated with set true; set role probe_admin")).toBe("probe_admin");
  });

  it("SET FALSE is not a path: such memberships alone do not stop the migration (16+)", async () => {
    const r = await gate(`create role probe_noset nologin; create role probe_inh nologin; grant select on events to probe_inh;
      grant probe_noset to authenticated with inherit false, set false;
      grant probe_inh to anon with inherit true, set false;  -- inherited SELECT on events: judged by the privilege checks`);
    expect(r.err).toBe("applied");
    expect(r.recorded).toBe(7);
    expect(await asSession(r.pg, "authenticated", "set role probe_noset")).toMatch(/^ERR permission denied to set role "probe_noset"/);
    expect(await asSession(r.pg, "anon", "set role probe_inh")).toMatch(/^ERR permission denied to set role "probe_inh"/);
  });

  it("an inherited (SET FALSE) membership that carries a forbidden privilege still stops — through the privilege checks", async () => {
    const r = await gate(`create role probe_inh2 nologin; grant delete on tasks to probe_inh2; grant probe_inh2 to authenticated with inherit true, set false;`);
    expect(r.err).toMatch(/still hold privileges beyond the intended surface.*authenticated DELETE on tasks/);
    expect(r.err).not.toMatch(SWITCH);
    expect(r.recorded).toBe(6);
    expect(r.unchanged).toBe(true);
  });

  it("the normal setup has no switch path, so a clean install is unaffected", async () => {
    const pg = await freshAt(5);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    const { rows } = await pg.query(`select b.rolname, x.rolname as target from pg_roles b cross join pg_roles x
      where b.rolname in ('anon', 'authenticated') and x.oid <> b.oid
        and (pg_has_role(b.oid, x.oid, 'SET') or pg_has_role(b.oid, x.oid, 'MEMBER WITH ADMIN OPTION'))`);
    expect(rows).toEqual([]);
    expect((await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(7);
  });

  it("PostgreSQL 15 branch (static check only): 'SET' is used only for 16+, no 16-only pg_auth_members columns, MEMBER + CREATEROLE before 16", () => {
    const sqlText = fs.readFileSync("drizzle/0006_access_hardening.sql", "utf8");
    const block = sqlText.slice(sqlText.indexOf("-- [hand-edit 6] fail closed"));
    const code = block.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"); // without comments
    expect(code).toMatch(/if current_setting\('server_version_num'\)::int >= 160000 then\s+switch_mode := 'SET';\s+else\s+switch_mode := 'MEMBER';\s+end if;/);
    expect(code.match(/'SET'/g)).toHaveLength(1); // only the assignment inside the 16+ branch
    expect(code).not.toMatch(/inherit_option|set_option|admin_option/);
    expect(code).toMatch(/if current_setting\('server_version_num'\)::int < 160000 then\s+select concat_ws\('; ', bad, string_agg\(format\('%s has CREATEROLE'/);
    for (const m of code.matchAll(/pg_auth_members m where ([^)]*)\)/g)) expect(m[1]).toBe("m.member = b.oid and m.roleid = x.oid");
  });
});

describe("default privileges the migration cannot make safe", () => {
  it("stops the migration if a default grants new public tables to a role anon/authenticated inherit", async () => {
    const pg = await freshAt(5);
    await pg.exec(`create role probe_group nologin; grant probe_group to authenticated with inherit true, set false;
      alter default privileges in schema public grant select on tables to probe_group;`);
    const before = await surface(pg);
    const err = await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 }).then(() => "applied", (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message);
    expect(err).toMatch(/default privileges would expose new public tables\/sequences: postgres\/public\/r -> probe_group \(SELECT\): grants a role that anon\/authenticated inherit/);
    expect((await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(6);
    expect(await surface(pg)).toEqual(before);
  });

  it("reports a creator role the migrating role cannot act for (only if that creator can create in public)", async () => {
    const pg = await freshAt(5);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    // A non-superuser migrating role and two other creator roles, as on a managed platform.
    await pg.exec(`
      create role limited_migrator nologin;
      grant usage on schema app to limited_migrator;
      grant execute on function app.unsafe_default_acls_0006() to limited_migrator;
      create role platform_admin nologin; grant create on schema public to platform_admin;
      create role other_creator nologin;  -- no CREATE on public: its defaults can never reach public tables
      alter default privileges for role platform_admin in schema public grant select, insert on tables to anon;
      alter default privileges for role other_creator in schema public grant select on tables to anon;`);
    const report = await pg.transaction(async (tx) => {
      await tx.exec("set local role limited_migrator");
      const rows = (await tx.query<{ creator: string; grantee: string; privileges: string; reason: string }>(
        "select creator::text, grantee, privileges, reason from app.unsafe_default_acls_0006() order by 1")).rows;
      await tx.rollback();
      return rows;
    }).catch((e: Error) => { throw e; });
    expect(report).toEqual([{ creator: "platform_admin", grantee: "anon", privileges: "INSERT, SELECT",
      reason: "grants browser roles access to new objects in public; limited_migrator cannot change this role's default privileges" }]);
  });

  it("a superuser migrating role does fix such entries itself (re-running the default-privilege step is safe)", async () => {
    const pg = await freshAt(5);
    await pg.exec(`create role platform_admin nologin; grant create on schema public to platform_admin;
      alter default privileges for role platform_admin in schema public grant select, insert on tables to anon;`);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    expect((await pg.query("select * from app.unsafe_default_acls_0006()")).rows).toEqual([]);
    const snap = (await pg.query("select creator::text, grantee::text, privilege_type from app.default_acl_before_0006 where creator = 'platform_admin' order by 3")).rows;
    expect(snap).toEqual([{ creator: "platform_admin", grantee: "anon", privilege_type: "INSERT" }, { creator: "platform_admin", grantee: "anon", privilege_type: "SELECT" }]);
    const before = await surface(pg);
    await pg.exec(fs.readFileSync(DOWN_SQL, "utf8"));
    const restored = (await pg.query<{ acl: string }>(`select defaclacl::text acl from pg_default_acl where defaclrole = 'platform_admin'::regrole`)).rows;
    expect(restored).toEqual([{ acl: "{anon=ar/platform_admin}" }]);
    expect(await surface(pg)).not.toEqual(before);
  });
});

describe("upgrade from 0005 with data", () => {
  it("applies 0006 without touching any row (QR tokens and AI profiles included)", async () => {
    const pg = await freshAt(5);
    const E = "e0000000-0000-4000-8000-000000000001";
    await pg.exec(`
      insert into auth.users (id, email) values ('${U.ownerA}', 'o@example.com');
      insert into organizations (id, name) values ('${ORG_A}', 'Org A');
      insert into users (id, organization_id, email, role) values ('${U.ownerA}', '${ORG_A}', 'o@example.com', 'owner');
      insert into events (id, organization_id, title, ai_config, ai_config_version) values ('${E}', '${ORG_A}', 'E', '{"event":{}}', 'blueprint/v1');
      insert into modules_registry (organization_id, event_id, module_type) values ('${ORG_A}', '${E}', 'stage');
      insert into attendees (organization_id, event_id, ticket_type, is_checked_in, checked_in_at) values
        ('${ORG_A}', '${E}', 'general', false, null), ('${ORG_A}', '${E}', 'vip', true, now());`);
    const snap = async () => ({
      a: (await pg.query("select * from attendees order by id")).rows,
      e: (await pg.query("select * from events order by id")).rows,
      m: (await pg.query("select * from modules_registry order by id")).rows,
    });
    const before = await snap();
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    expect((await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(7);
    expect(await snap()).toEqual(before);
    // a QR token still identifies its attendee (server-side lookup)
    const token = (before.a[0] as { qr_uuid: string }).qr_uuid;
    expect((await pg.query("select id from attendees where qr_uuid = $1", [token])).rows).toHaveLength(1);
  });
});

describe("pre-0006 privilege snapshot (app.acl_before_0006)", () => {
  it("records every public table's ACLs as they were before 0006, and is closed to browser roles", async () => {
    const pg = await freshAt(5);
    const before = (await pg.query<{ t: string; acl: string[] | null }>(`select c.relname t, (select array_agg(x::text order by x::text) from unnest(c.relacl) x) acl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`)).rows;
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    const snap = (await pg.query<{ t: string; acl: string[] | null }>("select table_name t, table_acl acl from app.acl_before_0006 order by 1")).rows;
    expect(snap).toEqual(before);
    expect(snap).toHaveLength(12);
    const { rows } = await pg.query(`select has_table_privilege('anon', 'app.acl_before_0006', 'SELECT') a, has_table_privilege('authenticated', 'app.acl_before_0006', 'SELECT') b`);
    expect(rows).toEqual([{ a: false, b: false }]);
  });

  it("records the default privileges of anon/authenticated (role, scope, object type, privilege, grant option)", async () => {
    const pg = await freshAt(5);
    const sel = `select pg_get_userbyid(d.defaclrole) creator, n.nspname schema_name, d.defaclobjtype::text objtype, pg_get_userbyid(e.grantee) grantee,
      e.privilege_type, e.is_grantable from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) e
      where e.grantee <> 0 and pg_get_userbyid(e.grantee) in ('anon', 'authenticated') order by 1, 2, 3, 4, 5`;
    const before = (await pg.query(sel)).rows;
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    const snap = (await pg.query(`select creator::text, schema_name::text, objtype::text, grantee::text, privilege_type, is_grantable
      from app.default_acl_before_0006 order by 1, 2, 3, 4, 5`)).rows;
    expect(snap).toEqual(before);
    // Supabase-style defaults: tables arwdDxtm (8 privileges) and sequences rwU (3) for each of the two roles
    expect(snap).toHaveLength(2 * 8 + 2 * 3);
    const { rows } = await pg.query(`select has_table_privilege('anon', 'app.default_acl_before_0006', 'SELECT') a, has_table_privilege('authenticated', 'app.default_acl_before_0006', 'SELECT') b`);
    expect(rows).toEqual([{ a: false, b: false }]);
  });
});

describe("rollback SQL (manual, never run by the migrator)", () => {
  it("is not part of the migration journal", () => {
    const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0006_access_hardening");
    expect(journal.entries.some((e) => e.tag.includes("down") || e.tag.includes("rollback"))).toBe(false);
    expect(fs.existsSync(DOWN_SQL)).toBe(true);
  });

  it("restores the exact 0005 surface, and 0006 can be re-applied afterwards", async () => {
    const pg = await freshAt(5);
    const at0005 = await surface(pg);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    const at0006 = await surface(pg);
    expect(at0006).not.toEqual(at0005);

    await pg.exec(fs.readFileSync(DOWN_SQL, "utf8"));
    expect(await surface(pg)).toEqual(at0005);

    // the rollback forgets 0006 in the same transaction (the 0000–0005 rows stay); migrate re-applies it
    const hash = createHash("sha256").update(fs.readFileSync("drizzle/0006_access_hardening.sql", "utf8")).digest("hex");
    expect((await pg.query("select id from drizzle.__drizzle_migrations where hash = $1", [hash])).rows).toHaveLength(0);
    expect((await pg.query("select id from drizzle.__drizzle_migrations")).rows).toHaveLength(6);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    expect(await surface(pg)).toEqual(at0006);
  });

  it("restores only privileges that really existed (a non-default pre-0006 surface comes back as it was)", async () => {
    const pg = await freshAt(5);
    // a database whose privileges differ from Supabase defaults before 0006
    await pg.exec(`
      revoke truncate on users from anon;
      revoke select on event_kpis from anon;
      revoke references, trigger on organizations from authenticated;
      grant select ("id", "title") on events to anon;
      -- default privileges too: a narrower schema entry, a global entry, and a grant option
      alter default privileges in schema public revoke references on tables from authenticated;
      alter default privileges grant truncate, select on tables to anon;
      alter default privileges in schema public grant trigger on tables to anon with grant option;`);
    const custom = await surface(pg);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    // explicit-grant model: 0006 removed the whole global browser default (TRUNCATE and SELECT); the entry
    // then equals PostgreSQL's built-in default, so PostgreSQL drops it
    const global = (await pg.query<{ acl: string }>(`select defaclacl::text acl from pg_default_acl where defaclnamespace = 0 and defaclobjtype = 'r'`)).rows;
    expect(global).toEqual([]);
    await pg.exec(fs.readFileSync(DOWN_SQL, "utf8"));
    expect(await surface(pg)).toEqual(custom);
    const { rows } = await pg.query(`select has_table_privilege('anon', 'users', 'TRUNCATE') t, has_table_privilege('anon', 'event_kpis', 'SELECT') s,
      has_table_privilege('authenticated', 'organizations', 'TRIGGER') g, has_table_privilege('authenticated', 'users', 'TRUNCATE') a`);
    expect(rows).toEqual([{ t: false, s: false, g: false, a: true }]);
  });

  it("handles PUBLIC: revokes PUBLIC writes and the four privileges (also in defaults), and the rollback restores them exactly", async () => {
    const pg = await freshAt(5);
    await pg.exec(`
      grant insert, truncate on organizations to public;
      grant insert, delete, references on users to public;
      grant update ("name") on organizations to public;
      grant select on event_kpis to public;
      alter default privileges in schema public grant trigger, select on tables to public;`);
    const custom = await surface(pg);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    const eff = async (role: string, table: string, priv: string) =>
      (await pg.query<{ v: boolean }>("select has_table_privilege($1, $2, $3) v", [role, table, priv])).rows[0]!.v;
    expect(await eff("anon", "organizations", "INSERT")).toBe(false);
    expect(await eff("anon", "organizations", "TRUNCATE")).toBe(false);
    expect(await eff("authenticated", "users", "INSERT")).toBe(false);
    expect(await eff("authenticated", "users", "REFERENCES")).toBe(false);
    expect((await pg.query<{ v: boolean }>(`select has_column_privilege('anon', 'organizations', 'name', 'UPDATE') v`)).rows[0]!.v).toBe(false);
    expect(await eff("anon", "event_kpis", "SELECT")).toBe(true); // PUBLIC SELECT is not touched
    await pg.exec("create table public.future_probe (id int)");
    expect(await eff("anon", "public.future_probe", "TRIGGER")).toBe(false); // PUBLIC defaults removed entirely
    expect(await eff("anon", "public.future_probe", "SELECT")).toBe(false);
    await pg.exec("drop table public.future_probe");
    await pg.exec(fs.readFileSync(DOWN_SQL, "utf8"));
    expect(await surface(pg)).toEqual(custom);
  });

  it("sequences: existing and default sequence privileges (PUBLIC, grant option, global) are removed and restored exactly", async () => {
    const pg = await freshAt(5);
    await pg.exec(`
      create sequence public.legacy_seq;
      grant usage on sequence public.legacy_seq to anon;
      grant select on sequence public.legacy_seq to authenticated with grant option;
      grant update on sequence public.legacy_seq to public;
      alter default privileges grant usage on sequences to public;
      alter default privileges in schema public grant select on sequences to authenticated with grant option;`);
    const custom = await surface(pg);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    const seq = async (role: string, s: string, priv: string) =>
      (await pg.query<{ v: boolean }>("select has_sequence_privilege($1, $2, $3) v", [role, s, priv])).rows[0]!.v;
    for (const role of ["anon", "authenticated"]) for (const priv of ["USAGE", "SELECT", "UPDATE"]) expect(await seq(role, "public.legacy_seq", priv)).toBe(false);
    await pg.exec("create sequence public.new_seq");
    for (const role of ["anon", "authenticated"]) for (const priv of ["USAGE", "SELECT", "UPDATE"]) expect(await seq(role, "public.new_seq", priv)).toBe(false);
    expect(await seq("service_role", "public.new_seq", "USAGE")).toBe(true);
    await pg.exec("drop sequence public.new_seq");
    await pg.exec(fs.readFileSync(DOWN_SQL, "utf8"));
    expect(await surface(pg)).toEqual(custom);
  });

  it("names the 0006 version it belongs to: journal \"when\" and the file's hash", () => {
    const down = fs.readFileSync(DOWN_SQL, "utf8");
    const when = (JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] })
      .entries.find((e) => e.tag === "0006_access_hardening")!.when;
    const hash = createHash("sha256").update(fs.readFileSync("drizzle/0006_access_hardening.sql", "utf8")).digest("hex");
    expect(down).toContain(`expected_when constant bigint := ${when};`);
    expect(down).toContain(`expected_hash constant text := '${hash}';`);
    expect(down).toContain(`where created_at = ${when} and hash = '${hash}'`);
  });

  /** Runs the rollback; returns the error (or "ran"), and whether surface and migration rows are unchanged. */
  async function tryRollback(pg: PGlite) {
    const rows = async () => (await pg.query("select id, hash, created_at::text from drizzle.__drizzle_migrations order by id")).rows;
    const [s0, r0] = [await surface(pg), await rows()];
    const err = await pg.exec(fs.readFileSync(DOWN_SQL, "utf8")).then(() => "ran", (e: Error) => e.message);
    await pg.exec("rollback").catch(() => undefined);
    return { err, unchanged: JSON.stringify([await surface(pg), await rows()]) === JSON.stringify([s0, r0]) };
  }

  it("refuses when 0006 is not recorded (not applied), and changes nothing", async () => {
    const pg = await freshAt(5);
    const r = await tryRollback(pg);
    expect(r.err).toContain("expected exactly one 0006 row (created_at 1792242997447), found 0");
    expect(r.unchanged).toBe(true);
  });

  it("refuses when a migration was applied after 0006 (later created_at or higher id), and changes nothing", async () => {
    for (const later of ["insert into drizzle.__drizzle_migrations (hash, created_at) values ('later', 1792242997448)",
                         "insert into drizzle.__drizzle_migrations (hash, created_at) values ('same-time-later-id', 1792242997000)"]) {
      const pg = await freshAt(5);
      await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
      await pg.exec(later);
      const r = await tryRollback(pg);
      expect(r.err).toContain("1 migration(s) were applied after 0006; roll them back first");
      expect(r.unchanged).toBe(true);
    }
  });

  it("refuses when the recorded 0006 is another version (hash), or the table is not drizzle's, and changes nothing", async () => {
    const pg = await freshAt(5);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    await pg.exec("update drizzle.__drizzle_migrations set hash = 'an-older-0006' where created_at = 1792242997447");
    let r = await tryRollback(pg);
    expect(r.err).toMatch(/the recorded 0006 \(hash an-older-0006\) is not the version this rollback belongs to/);
    expect(r.unchanged).toBe(true);

    const pg2 = await freshAt(5);
    await migrate(drizzle({ client: pg2 }), { migrationsFolder: UP_TO_0006 });
    await pg2.exec("alter table drizzle.__drizzle_migrations alter column created_at type text");
    r = await tryRollback(pg2);
    expect(r.err).toContain("does not have the expected columns id integer, hash text, created_at bigint");
    expect(r.unchanged).toBe(true);
  });

  it("default privileges: restores only what 0006 removed and leaves later, unrelated changes alone", async () => {
    const pg = await freshAt(5);
    await pg.exec(`create schema reporting;
      alter default privileges in schema reporting grant select, truncate on tables to authenticated;`);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    const defaults = async () => (await pg.query<{ d: string }>(`select pg_get_userbyid(d.defaclrole) || '/' || coalesce(n.nspname, '<global>') || '/'
        || d.defaclobjtype::text || '/' || pg_get_userbyid(e.grantee) || ':' || e.privilege_type as d
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) e
      where e.grantee <> 0 and pg_get_userbyid(e.grantee) in ('anon', 'authenticated') order by 1`)).rows.map((r) => r.d);
    expect(await defaults()).toEqual(["postgres/reporting/r/authenticated:SELECT"]); // 0006 removed TRUNCATE there
    // after 0006, unrelated changes: SELECT in reporting withdrawn, a type default added
    await pg.exec(`alter default privileges in schema reporting revoke select on tables from authenticated;
      alter default privileges in schema public grant usage on types to anon;`);
    await pg.exec(fs.readFileSync(DOWN_SQL, "utf8"));
    const after = await defaults();
    expect(after).toContain("postgres/reporting/r/authenticated:TRUNCATE"); // removed by 0006 → restored
    expect(after).not.toContain("postgres/reporting/r/authenticated:SELECT"); // withdrawn after 0006 → stays withdrawn
    expect(after).toContain("postgres/public/T/anon:USAGE"); // added after 0006 → kept
    for (const role of ["anon", "authenticated"]) { // public tables/sequences: the pre-0006 defaults are back
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect(after).toContain(`postgres/public/r/${role}:${priv}`);
      for (const priv of ["SELECT", "UPDATE", "USAGE"]) expect(after).toContain(`postgres/public/S/${role}:${priv}`);
    }
  });

  it.each([["app.acl_before_0006"], ["app.default_acl_before_0006"]])("refuses to run without %s and changes nothing", async (table) => {
    const pg = await freshAt(5);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    await pg.exec(`drop table ${table}`);
    const at0006 = await surface(pg);
    const err = await pg.exec(fs.readFileSync(DOWN_SQL, "utf8")).then(() => "ran", (e: Error) => e.message);
    expect(err).toContain(`${table} is missing`);
    await pg.exec("rollback").catch(() => undefined); // leave the aborted transaction, if PGlite kept it open
    expect(await surface(pg)).toEqual(at0006);
  });

  it("service_role's table and default privileges are identical before 0006, after it, and after the rollback", async () => {
    const pg = await freshAt(5);
    const svc = async () => ({
      tables: (await pg.query(`select c.relname, e.privilege_type from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) e
        where n.nspname = 'public' and c.relkind = 'r' and pg_get_userbyid(e.grantee) = 'service_role' order by 1, 2`)).rows,
      defaults: (await pg.query(`select d.defaclobjtype::text, e.privilege_type from pg_default_acl d cross join lateral aclexplode(d.defaclacl) e
        where pg_get_userbyid(e.grantee) = 'service_role' order by 1, 2`)).rows,
    });
    const before = await svc();
    expect(before.tables).toHaveLength(12 * 8);
    await migrate(drizzle({ client: pg }), { migrationsFolder: UP_TO_0006 });
    expect(await svc()).toEqual(before);
    await pg.exec(fs.readFileSync(DOWN_SQL, "utf8"));
    expect(await svc()).toEqual(before);
  });
});
