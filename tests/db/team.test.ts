/**
 * Team management and event lifecycle (0009) on a real migrated database: invitations, roles, removal,
 * organization settings, archiving, duplicating and the attendee CSV. `@/db` is mocked so adminDb is PGlite.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { attendees, eventKpis, events, organizationInvitations, organizations, surveyQuestions, surveys, tasks, users } from "@/db/schema";
import { ORG_A, ORG_B, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => {
  class UnauthenticatedError extends Error {}
  return {
    UnauthenticatedError,
    getUserDb: async () => { throw new UnauthenticatedError("not used"); },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});

const team = await import("@/server/org/team-service");
const life = await import("@/server/events/lifecycle-service");
const { ApiError } = await import("@/server/http");
type OrgAccess = import("@/server/auth/org-access").OrgAccess;

let ctx: Awaited<ReturnType<typeof setupDb>>;
const access = (userId: string, role: OrgAccess["role"], organizationId = ORG_A): OrgAccess =>
  ({ userId, organizationId, organizationName: "Org", organizerType: "OTHER", role });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ApiError ? `${e.status} ${e.code ?? e.message}` : `unexpected: ${(e as Error).message}`;
  }
};
const NEW = {
  a: "d1000000-0000-4000-8000-000000000001",
  b: "d1000000-0000-4000-8000-000000000002",
  c: "d1000000-0000-4000-8000-000000000003",
};

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  for (const [k, id] of Object.entries(NEW)) await ctx.pg.query("insert into auth.users (id, email) values ($1, $2)", [id, `new-${k}@example.com`]);
});

describe("invitations", () => {
  it("owner invites admin; admin may invite staff only; staff may not invite", async () => {
    const ownerA = access(U.ownerA, "owner");
    const r = await team.createInvitation(ownerA, { organizationId: ORG_A, email: "New-A@Example.com", role: "admin" });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.invitation).toMatchObject({ email: "new-a@example.com", role: "admin", invitedByEmail: "ownerA@example.com" });
    const stored = await ctx.db.select().from(organizationInvitations).where(eq(organizationInvitations.id, r.invitation.id));
    expect(stored[0]!.tokenHash).not.toBe(r.token);
    expect(await code(team.createInvitation(access(U.ownerA, "admin"), { organizationId: ORG_A, email: "x@example.com", role: "admin" }))).toBe("403 ROLE_NOT_ALLOWED");
    expect(await code(team.createInvitation(access(U.staffA, "staff"), { organizationId: ORG_A, email: "x@example.com", role: "staff" }))).toBe("403 Insufficient role");
  });

  it("existing members cannot be invited, here or elsewhere", async () => {
    expect(await code(team.createInvitation(access(U.ownerA, "owner"), { organizationId: ORG_A, email: "staffA@example.com", role: "staff" }))).toBe("409 ALREADY_IN_ORGANIZATION");
    expect(await code(team.createInvitation(access(U.ownerA, "owner"), { organizationId: ORG_A, email: "ownerB@example.com", role: "staff" }))).toBe("409 MEMBER_OF_OTHER_ORGANIZATION");
  });

  it("re-inviting an address replaces the old link; describe shows the state", async () => {
    const ownerA = access(U.ownerA, "owner");
    const first = await team.createInvitation(ownerA, { organizationId: ORG_A, email: "new-b@example.com", role: "staff" });
    const second = await team.createInvitation(ownerA, { organizationId: ORG_A, email: "new-b@example.com", role: "staff" });
    expect((await team.describeInvitation(first.token)).state).toBe("revoked");
    expect(await team.describeInvitation(second.token)).toMatchObject({ state: "open", email: "new-b@example.com", role: "staff" });
    expect((await team.listInvitations(ownerA)).filter((i) => i.email === "new-b@example.com")).toHaveLength(1);
    expect(await code(team.describeInvitation("A".repeat(43)))).toBe("404 INVITATION_NOT_FOUND");
  });

  it("accepting: same address only, once, account without organization; then member with the invited role", async () => {
    const r = await team.createInvitation(access(U.ownerA, "owner"), { organizationId: ORG_A, email: "new-c@example.com", role: "staff" });
    expect(await code(team.acceptInvitation({ sub: NEW.a, email: "new-a@example.com" }, r.token))).toBe("403 INVITATION_EMAIL_MISMATCH");
    expect(await code(team.acceptInvitation({ sub: U.ownerB, email: "new-c@example.com" }, r.token))).toBe("409 ALREADY_MEMBER");
    const m = await team.acceptInvitation({ sub: NEW.c, email: "NEW-C@example.com" }, r.token);
    expect(m).toMatchObject({ organizationId: ORG_A, role: "staff", userId: NEW.c });
    expect(await code(team.acceptInvitation({ sub: NEW.c, email: "new-c@example.com" }, r.token))).toBe("410 INVITATION_ACCEPTED");
    expect((await team.listMembers(access(U.ownerA, "owner"))).map((x) => x.email)).toContain("new-c@example.com");
  });

  it("expired and revoked invitations cannot be accepted; revoke is scoped to the organization", async () => {
    const ownerA = access(U.ownerA, "owner");
    const exp = await team.createInvitation(ownerA, { organizationId: ORG_A, email: "late@example.com", role: "staff" });
    await ctx.db.update(organizationInvitations).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(organizationInvitations.id, exp.invitation.id));
    expect(await code(team.acceptInvitation({ sub: NEW.b, email: "late@example.com" }, exp.token))).toBe("410 INVITATION_EXPIRED");
    const rev = await team.createInvitation(ownerA, { organizationId: ORG_A, email: "gone@example.com", role: "staff" });
    expect(await code(team.revokeInvitation(access(U.ownerB, "owner", ORG_B), rev.invitation.id))).toBe("404 Invitation not found");
    await team.revokeInvitation(ownerA, rev.invitation.id);
    expect((await team.describeInvitation(rev.token)).state).toBe("revoked");
  });
});

describe("roles and removal", () => {
  it("only an owner changes roles; the last owner cannot be demoted or removed", async () => {
    const ownerA = access(U.ownerA, "owner");
    expect(await code(team.changeMemberRole(access(U.ownerA, "admin"), U.staffA, "admin"))).toBe("403 ROLE_NOT_ALLOWED");
    expect(await code(team.changeMemberRole(ownerA, U.ownerA, "admin"))).toBe("409 LAST_OWNER");
    expect(await code(team.removeMember(ownerA, U.ownerA))).toBe("409 LAST_OWNER");
    await team.changeMemberRole(ownerA, U.staffA, "admin");
    expect((await ctx.db.select({ role: users.role }).from(users).where(eq(users.id, U.staffA)))[0]!.role).toBe("admin");
    await team.changeMemberRole(ownerA, U.staffA, "staff");
    expect(await code(team.changeMemberRole(ownerA, U.ownerB, "staff"))).toBe("404 Member not found");
  });

  it("admins remove staff only; staff may only leave; a removed member's sessions end", async () => {
    // NEW.c joined ORG_A as staff above
    expect(await code(team.removeMember(access(U.staffA, "staff"), NEW.c))).toBe("403 Insufficient role");
    expect(await code(team.removeMember(access(U.staffA, "admin"), U.ownerA))).toBe("403 ROLE_NOT_ALLOWED");
    await ctx.pg.query("insert into auth.sessions (user_id, token_hash, expires_at) values ($1, 'x-hash', now() + interval '1 day')", [NEW.c]);
    await team.removeMember(access(U.staffA, "admin"), NEW.c);
    expect((await ctx.db.select().from(users).where(eq(users.id, NEW.c)))).toHaveLength(0);
    expect((await ctx.pg.query("select count(*)::int n from auth.sessions where user_id = $1", [NEW.c])).rows).toEqual([{ n: 0 }]);
  });

  it("organization settings", async () => {
    const org = await team.updateOrganization(access(U.ownerA, "owner"), { organizationId: ORG_A, name: "Org A Yeni", organizerType: "MUNICIPALITY" });
    expect(org).toMatchObject({ name: "Org A Yeni", organizerType: "MUNICIPALITY" });
    expect((await ctx.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ORG_B)))[0]!.name).toBe("Org B");
  });
});

describe("event lifecycle", () => {
  it("archive / restore, scoped to the organization", async () => {
    const [ev] = await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Arşiv Testi" }).returning();
    expect(await code(life.setEventArchived(access(U.ownerB, "owner", ORG_B), ev!.id, true))).toBe("404 Event not found");
    expect((await life.setEventArchived(access(U.ownerA, "owner"), ev!.id, true)).archivedAt).not.toBeNull();
    expect((await life.setEventArchived(access(U.ownerA, "owner"), ev!.id, false)).archivedAt).toBeNull();
  });

  it("duplicate copies plan, KPIs and surveys as a new draft, not tickets", async () => {
    const [ev] = await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Kaynak", status: "live", startDate: "2026-11-10", endDate: "2026-11-11" }).returning();
    const [t1] = await ctx.db.insert(tasks).values({ organizationId: ORG_A, eventId: ev!.id, title: "Mekan", status: "DONE", dueOffsetDays: -30 }).returning();
    await ctx.db.insert(tasks).values({ organizationId: ORG_A, eventId: ev!.id, title: "Ses", dueOffsetDays: -7, dependsOn: [t1!.id] });
    await ctx.db.insert(eventKpis).values({ organizationId: ORG_A, eventId: ev!.id, metricName: "attendance_total", targetValue: "500", actualValue: "480", dataSource: "ticket_sales", status: "ACTIVE" });
    const [sv] = await ctx.db.insert(surveys).values({ organizationId: ORG_A, eventId: ev!.id, audience: "ATTENDEE", title: "Memnuniyet" }).returning();
    await ctx.db.insert(surveyQuestions).values({ organizationId: ORG_A, eventId: ev!.id, surveyId: sv!.id, questionText: "Nasıldı?", type: "SINGLE_CHOICE", options: [{ value: "iyi", label: "İyi" }, { value: "kotu", label: "Kötü" }] });
    await ctx.db.insert(attendees).values({ organizationId: ORG_A, eventId: ev!.id, ticketType: "Genel" });

    const copy = await life.duplicateEvent(access(U.ownerA, "owner"), ev!.id, { organizationId: ORG_A, startDate: "2027-05-01" });
    expect(copy).toMatchObject({ title: "Kaynak (kopya)", copied: { tasks: 2, kpis: 1, surveys: 1 } });
    const [ne] = await ctx.db.select().from(events).where(eq(events.id, copy.id));
    expect(ne).toMatchObject({ status: "draft", startDate: "2027-05-01", endDate: null });
    const nt = await ctx.db.select().from(tasks).where(eq(tasks.eventId, copy.id)).orderBy(tasks.dueOffsetDays);
    expect(nt.map((t) => [t.title, t.status, t.dueDate])).toEqual([["Mekan", "TODO", "2027-04-01"], ["Ses", "TODO", "2027-04-24"]]);
    expect(nt[1]!.dependsOn).toEqual([nt[0]!.id]);
    const [nk] = await ctx.db.select().from(eventKpis).where(eq(eventKpis.eventId, copy.id));
    expect(nk).toMatchObject({ targetValue: "500.0000", actualValue: null });
    const [ns] = await ctx.db.select().from(surveys).where(eq(surveys.eventId, copy.id));
    expect(ns).toMatchObject({ status: "DRAFT", publicToken: null, title: "Memnuniyet" });
    expect(await ctx.db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, ns!.id))).toHaveLength(1);
    expect(await ctx.db.select().from(attendees).where(eq(attendees.eventId, copy.id))).toHaveLength(0);
  });

  it("attendee CSV: BOM, header, no QR token, formula-safe", async () => {
    const [ev] = await ctx.db.insert(events).values({ organizationId: ORG_A, title: "CSV" }).returning();
    await ctx.db.insert(attendees).values([{ organizationId: ORG_A, eventId: ev!.id, ticketType: "=HYPERLINK(1)" }, { organizationId: ORG_A, eventId: ev!.id, ticketType: "VIP" }]);
    const csv = await life.attendeesCsv(access(U.ownerA, "owner"), ev!.id);
    expect(csv.startsWith("﻿\"Bilet No\";\"Bilet Türü\"")).toBe(true);
    expect(csv).toContain("\"'=HYPERLINK(1)\"");
    expect(csv.trim().split("\r\n")).toHaveLength(3);
    const [qr] = (await ctx.pg.query<{ q: string }>("select qr_uuid::text q from attendees where event_id = $1 limit 1", [ev!.id])).rows;
    expect(csv).not.toContain(qr!.q);
  });
});
