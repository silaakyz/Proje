/**
 * The API surface the frontend uses (session/onboarding, events, AI read endpoints, attendees + QR +
 * check-in incl. the SSE feed, impact gate, tasks/KPIs), called as Route Handlers with real Request
 * objects on PGlite with all migrations (0000–0007).
 *  - Sign-in is simulated at the src/db seam (getUserDb / getVerifiedClaims); everything below it is real:
 *    RLS for user-scoped reads/writes, requireOrgPermission, adminDb for server-only writes.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { attendees, eventKpis, events, organizations, proposals, tasks, users } from "@/db/schema";
import { ORG_A, ORG_B, setupDb, U } from "./helpers";
import { coreExample, respondWith, type MockState } from "./ai-mocks";

const h = vi.hoisted(() => ({
  db: null as unknown, user: null as string | null, email: null as string | null,
  after: [] as (() => unknown)[],
  ai: { respond: () => "{}", calls: [] } as unknown as MockState,
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { h.after.push(fn); } }));
vi.mock("@/server/ai/models", async (orig) => {
  const real = await orig<typeof import("@/server/ai/models")>();
  const { mockModel } = await import("./ai-mocks");
  // the provider key check is exercised separately; here the model is the mock
  return { ...real, modelFor: () => mockModel(h.ai), assertAiConfigured: () => {} };
});
vi.mock("@/db", async () => {
  const { withRls } = await import("@/db/rls");
  class UnauthenticatedError extends Error {}
  const claims = () => {
    if (!h.user) throw new UnauthenticatedError("Not signed in");
    return { sub: h.user, ...(h.email ? { email: h.email } : {}) };
  };
  return {
    UnauthenticatedError,
    getVerifiedClaims: async () => claims(),
    getUserDb: async () => {
      const c = claims();
      return <T,>(fn: Parameters<typeof withRls<T>>[2]) => withRls(h.db as never, c, fn);
    },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});

const meRoute = await import("@/app/api/me/route");
const eventsRoute = await import("@/app/api/events/route");
const eventRoute = await import("@/app/api/events/[eventId]/route");
const blueprintRoute = await import("@/app/api/ai/blueprint/route");
const sectionsRoute = await import("@/app/api/ai/blueprint/sections/route");
const generationRoute = await import("@/app/api/ai/generations/[generationId]/route");
const proposalsListRoute = await import("@/app/api/proposals/route");
const proposalRoute = await import("@/app/api/proposals/[proposalId]/route");
const attendeesRoute = await import("@/app/api/events/[eventId]/attendees/route");
const qrRoute = await import("@/app/api/events/[eventId]/attendees/[attendeeId]/qr/route");
const checkinRoute = await import("@/app/api/events/[eventId]/checkin/route");
const cancelAttendeesRoute = await import("@/app/api/events/[eventId]/attendees/cancel/route");
const undoCheckinRoute = await import("@/app/api/events/[eventId]/checkin/undo/route");
const ticketsRoute = await import("@/app/api/events/[eventId]/tickets/route");
const checkinsRoute = await import("@/app/api/events/[eventId]/checkins/route");
const streamRoute = await import("@/app/api/events/[eventId]/checkins/stream/route");
const tasksRoute = await import("@/app/api/events/[eventId]/tasks/route");
const kpisRoute = await import("@/app/api/events/[eventId]/kpis/route");
const kpiDecisionRoute = await import("@/app/api/kpis/[kpiId]/route");
const taskRoute = await import("@/app/api/tasks/[taskId]/route");
const impactRoute = await import("@/app/api/events/[eventId]/impact/route");
const impactRunsRoute = await import("@/app/api/events/[eventId]/impact/runs/route");
const impactRunRoute = await import("@/app/api/impact-runs/[runId]/route");
const onboardingRoute = await import("@/app/api/onboarding/route");

let ctx: Awaited<ReturnType<typeof setupDb>>;
const NEW_USER = "d0000000-0000-4000-8000-000000000001";
const ADMIN_A = "a0000000-0000-4000-8000-000000000003";

const req = (method: string, body?: unknown, url = "http://test.local/api") =>
  new Request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const as = (user: string | null, email: string | null = null) => { h.user = user; h.email = email; };

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  await ctx.pg.query("insert into auth.users (id, email) values ($1, 'adminA@example.com'), ($2, 'new@example.com')", [ADMIN_A, NEW_USER]);
  await ctx.db.insert(users).values({ id: ADMIN_A, organizationId: ORG_A, email: "adminA@example.com", role: "admin" });
  h.ai.respond = respondWith({}, await coreExample());
}, 60_000);
const drainAfter = async () => { while (h.after.length) await h.after.shift()!(); };

describe("GET /api/me", () => {
  it("401 without a session", async () => {
    as(null);
    expect((await meRoute.GET()).status).toBe(401);
  });

  it("a member gets their organization, role and permissions", async () => {
    as(U.staffA, "staffA@example.com");
    const r = await meRoute.GET();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      user: { id: U.staffA, email: "staffA@example.com" },
      membership: { organization: { id: ORG_A, name: "Org A", organizerType: "OTHER" }, role: "staff", permissions: ["org.read", "task.update_status", "checkin.perform", "survey.collect"] },
    });
    as(U.ownerA);
    const owner = await (await meRoute.GET()).json();
    expect(owner.membership.permissions).toEqual(["org.read", "task.update_status", "blueprint.generate", "proposal.decide", "event.write", "attendee.read", "attendee.write", "checkin.perform", "survey.manage", "survey.collect", "impact.manage", "member.manage", "org.manage", "budget.read", "budget.manage", "data.manage"]);
  });

  it("a signed-in user without a profile gets membership: null (must onboard)", async () => {
    as(NEW_USER, "new@example.com");
    expect(await (await meRoute.GET()).json()).toEqual({ user: { id: NEW_USER, email: "new@example.com" }, membership: null });
  });
});

describe("POST /api/onboarding", () => {
  it("401 without a session; 400 for an invalid body; nothing created", async () => {
    const before = (await ctx.db.select().from(organizations)).length;
    as(null);
    expect((await onboardingRoute.POST(req("POST", { organizationName: "X Belediyesi" }))).status).toBe(401);
    as(NEW_USER, "new@example.com");
    expect((await onboardingRoute.POST(req("POST", { organizationName: "X" }))).status).toBe(400);
    expect((await onboardingRoute.POST(req("POST", { organizationName: "Geçerli Ad", organizerType: "NOT_A_TYPE" }))).status).toBe(400);
    expect((await ctx.db.select().from(organizations)).length).toBe(before);
  });

  it("creates the organization and makes the caller its owner (identity from the session, not the body)", async () => {
    as(NEW_USER, "new@example.com");
    const r = await onboardingRoute.POST(req("POST", { organizationName: "Seyhan Belediyesi", organizerType: "MUNICIPALITY", userId: U.ownerA, role: "staff" }));
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.membership).toMatchObject({ organization: { name: "Seyhan Belediyesi", organizerType: "MUNICIPALITY" }, role: "owner" });
    const [row] = await ctx.db.select().from(users).where(eq(users.id, NEW_USER));
    expect(row).toMatchObject({ organizationId: body.membership.organization.id, email: "new@example.com", role: "owner" });
    // /api/me now reports the membership, read under RLS
    expect((await (await meRoute.GET()).json()).membership.organization.id).toBe(body.membership.organization.id);
  });

  it("409 for a user who already has a profile; nothing created", async () => {
    const before = (await ctx.db.select().from(organizations)).length;
    as(U.ownerA, "ownerA@example.com");
    const r = await onboardingRoute.POST(req("POST", { organizationName: "İkinci Kurum" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "ALREADY_MEMBER", organizationId: ORG_A });
    expect((await ctx.db.select().from(organizations)).length).toBe(before);
  });

  it("409 when the email is already used by another profile; the organization insert is rolled back", async () => {
    const other = "d0000000-0000-4000-8000-000000000002";
    // auth.users is unique on lower(email), so sign-up cannot create this; the onboarding guard is defence in
    // depth for a profile email that differs from the account's (e.g. imported data).
    await ctx.pg.query("insert into auth.users (id, email) values ($1, 'other-account@example.com')", [other]);
    const before = (await ctx.db.select().from(organizations)).length;
    as(other, "OWNERA@example.com");
    const r = await onboardingRoute.POST(req("POST", { organizationName: "Kopya Kurum" }));
    expect(r.status).toBe(409);
    expect((await ctx.db.select().from(organizations)).length).toBe(before);
  });

  it("400 when the session carries no email", async () => {
    const other = "d0000000-0000-4000-8000-000000000003";
    await ctx.pg.query("insert into auth.users (id, email) values ($1, null)", [other]);
    as(other, null);
    const r = await onboardingRoute.POST(req("POST", { organizationName: "E-postasız" }));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: "NO_EMAIL" });
  });
});


const url = (path: string, q: Record<string, string> = {}) => `http://test.local${path}?${new URLSearchParams(q)}`;
const get = (path: string, q: Record<string, string> = {}) => new Request(url(path, q), { method: "GET" });
const P = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

describe("events API", () => {
  let eventB = "";
  let created = "";
  beforeAll(async () => {
    [{ id: eventB }] = (await ctx.db.insert(events).values({ organizationId: ORG_B, title: "B etkinliği" }).returning({ id: events.id })) as [{ id: string }];
  });

  it("POST: owner creates an event in their organization (201); staff and other tenants get 403 and nothing is created", async () => {
    as(U.staffA);
    expect((await eventsRoute.POST(req("POST", { organizationId: ORG_A, title: "Staff etkinliği" }))).status).toBe(403);
    as(U.ownerB);
    expect((await eventsRoute.POST(req("POST", { organizationId: ORG_A, title: "Sızma" }))).status).toBe(403);
    as(null);
    expect((await eventsRoute.POST(req("POST", { organizationId: ORG_A, title: "Anonim" }))).status).toBe(401);
    as(U.ownerA);
    const r = await eventsRoute.POST(req("POST", { organizationId: ORG_A, title: "  Adana Lezzet Festivali ", startDate: "2027-04-20", endDate: "2027-04-22" }));
    expect(r.status).toBe(201);
    const { event } = await r.json();
    created = event.id;
    expect(event).toMatchObject({ title: "Adana Lezzet Festivali", status: "draft", startDate: "2027-04-20", endDate: "2027-04-22", fromBlueprint: false });
    const titles = (await ctx.db.select({ t: events.title }).from(events)).map((x) => x.t);
    expect(titles).not.toContain("Staff etkinliği");
    expect(titles).not.toContain("Sızma");
  });

  it("POST: 400 for invalid input (missing title, end before start, bad organizationId)", async () => {
    as(U.ownerA);
    expect((await eventsRoute.POST(req("POST", { organizationId: ORG_A, title: "" }))).status).toBe(400);
    expect((await eventsRoute.POST(req("POST", { organizationId: ORG_A, title: "Ters", startDate: "2027-05-02", endDate: "2027-05-01" }))).status).toBe(400);
    expect((await eventsRoute.POST(req("POST", { organizationId: "nope", title: "X" }))).status).toBe(400);
  });

  it("GET list: members see only their organization's events; status filter; 400/401/403", async () => {
    as(U.staffA);
    const r = await eventsRoute.GET(get("/api/events", { organizationId: ORG_A }));
    expect(r.status).toBe(200);
    const list = (await r.json()).events as { id: string; title: string }[];
    expect(list.map((e) => e.id)).toContain(created);
    expect(list.map((e) => e.id)).not.toContain(eventB);
    expect((await (await eventsRoute.GET(get("/api/events", { organizationId: ORG_A, status: "live" }))).json()).events).toEqual([]);
    expect((await eventsRoute.GET(get("/api/events", { organizationId: ORG_A, status: "bogus" }))).status).toBe(400);
    expect((await eventsRoute.GET(get("/api/events", {}))).status).toBe(400);
    expect((await eventsRoute.GET(get("/api/events", { organizationId: ORG_B }))).status).toBe(403);
    as(null);
    expect((await eventsRoute.GET(get("/api/events", { organizationId: ORG_A }))).status).toBe(401);
  });

  it("GET detail: profile, modules and counts for a member; another tenant's event is a 404", async () => {
    await ctx.db.insert(attendees).values([
      { organizationId: ORG_A, eventId: created, ticketType: "genel" },
      { organizationId: ORG_A, eventId: created, ticketType: "genel", isCheckedIn: true, checkedInAt: new Date() },
    ]);
    await ctx.db.insert(tasks).values({ organizationId: ORG_A, eventId: created, title: "Valilik izni" } as never);
    as(U.staffA);
    const r = await eventRoute.GET(get(`/api/events/${created}`, { organizationId: ORG_A }), P({ eventId: created }));
    expect(r.status).toBe(200);
    const { event } = await r.json();
    expect(event).toMatchObject({ id: created, profile: null, modules: [], counts: { tasks: { TODO: 1 }, kpis: 0, surveys: 0, pendingProposals: 0, attendees: { total: 2, checkedIn: 1 } } });
    as(U.ownerA);
    expect((await eventRoute.GET(get(`/api/events/${eventB}`, { organizationId: ORG_A }), P({ eventId: eventB }))).status).toBe(404);
    expect((await eventRoute.GET(get(`/api/events/${eventB}`, { organizationId: ORG_B }), P({ eventId: eventB }))).status).toBe(403);
    expect((await eventRoute.GET(get(`/api/events/x`, { organizationId: ORG_A }), P({ eventId: "x" }))).status).toBe(400);
  });

  it("PATCH: admin updates title/status/dates; data rules give 422; staff 403; other tenant 404", async () => {
    as(ADMIN_A);
    let r = await eventRoute.PATCH(req("PATCH", { organizationId: ORG_A, title: "Adana Lezzet Festivali 2027", status: "live" }), P({ eventId: created }));
    expect(r.status).toBe(200);
    expect((await r.json()).event).toMatchObject({ title: "Adana Lezzet Festivali 2027", status: "live" });
    r = await eventRoute.PATCH(req("PATCH", { organizationId: ORG_A, startDate: null }), P({ eventId: created }));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ code: "INVALID_EVENT", constraint: "events_live_needs_dates" });
    expect((await eventRoute.PATCH(req("PATCH", { organizationId: ORG_A }), P({ eventId: created }))).status).toBe(400);
    expect((await eventRoute.PATCH(req("PATCH", { organizationId: ORG_A, title: "Başkasının" }), P({ eventId: eventB }))).status).toBe(404);
    as(U.staffA);
    expect((await eventRoute.PATCH(req("PATCH", { organizationId: ORG_A, title: "Staff" }), P({ eventId: created }))).status).toBe(403);
    // AI profile fields are not part of the API and stay untouched
    as(U.ownerA);
    await eventRoute.PATCH(req("PATCH", { organizationId: ORG_A, title: "Son ad", aiConfig: { x: 1 }, organizationId2: ORG_B }), P({ eventId: created }));
    const [row] = await ctx.db.select().from(events).where(eq(events.id, created));
    expect(row).toMatchObject({ title: "Son ad", aiConfig: null, organizationId: ORG_A, startDate: "2027-04-20" });
  });

it("PATCH event start date: moves relative tasks but preserves manual and completed dates", async () => {
  // This event starts on 2027-04-20 in the existing test setup.
  const [relative] = await ctx.db.insert(tasks).values({
    organizationId: ORG_A,
    eventId: created,
    title: "Relative date test",
    status: "TODO",
    dueOffsetDays: 5,
    dueDate: "2027-04-25",
  } as never).returning({ id: tasks.id });

  const [manual] = await ctx.db.insert(tasks).values({
    organizationId: ORG_A,
    eventId: created,
    title: "Manual date test",
    status: "TODO",
    dueOffsetDays: 5,
    dueDate: "2027-04-28",
  } as never).returning({ id: tasks.id });

  const [completed] = await ctx.db.insert(tasks).values({
    organizationId: ORG_A,
    eventId: created,
    title: "Completed task test",
    status: "DONE",
    dueOffsetDays: 5,
    dueDate: "2027-04-25",
  } as never).returning({ id: tasks.id });

  const [completedBefore] = await ctx.db
    .select({ completedAt: tasks.completedAt })
    .from(tasks)
    .where(eq(tasks.id, completed!.id));

  expect(completedBefore!.completedAt).not.toBeNull();

  as(U.ownerA);

  const response = await eventRoute.PATCH(
  req("PATCH", {
    organizationId: ORG_A,
    startDate: "2027-05-10",
    endDate: "2027-05-12",
  }),
  P({ eventId: created }),
);

  expect(response.status).toBe(200);

  // The relative task moves from April 25 to May 15.
  const [relativeAfter] = await ctx.db
    .select({ dueDate: tasks.dueDate })
    .from(tasks)
    .where(eq(tasks.id, relative!.id));

  expect(relativeAfter!.dueDate).toBe("2027-05-15");

  // The manually adjusted date stays unchanged.
  const [manualAfter] = await ctx.db
    .select({ dueDate: tasks.dueDate })
    .from(tasks)
    .where(eq(tasks.id, manual!.id));

  expect(manualAfter!.dueDate).toBe("2027-04-28");

  // Completed tasks keep both their date and completion timestamp.
  const [completedAfter] = await ctx.db
    .select({
      dueDate: tasks.dueDate,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, completed!.id));

  expect(completedAfter!.dueDate).toBe("2027-04-25");
  expect(completedAfter!.completedAt?.toISOString())
    .toBe(completedBefore!.completedAt?.toISOString());
});

it("GET proposals: expires stale pending proposals but keeps future proposals pending", async () => {
  const expiredCreatedAt = new Date(Date.now() - 120_000);
  const expiredAt = new Date(Date.now() - 60_000);

  const [expired] = await ctx.db.insert(proposals).values({

   organizationId: ORG_A,
   eventId: created,
   kind: "blueprint.tasks",
   title: "Expired proposal test",
   schemaVersion: "blueprint/v1",
   payload: { operations: [] },
   aiFingerprint: "a".repeat(64),
   createdAt: expiredCreatedAt,
   expiresAt: expiredAt,
  }).returning({ id: proposals.id, status: proposals.status });

  const [future] = await ctx.db.insert(proposals).values({
    organizationId: ORG_A,
    eventId: created,
    kind: "blueprint.tasks",
    title: "Future proposal test",
    schemaVersion: "blueprint/v1",
    payload: { operations: [] },
    aiFingerprint: "b".repeat(64),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  }).returning({ id: proposals.id, status: proposals.status });

  expect(expired!.status).toBe("PENDING");
  expect(future!.status).toBe("PENDING");

  as(U.ownerA);

  const response = await proposalsListRoute.GET(
    get("/api/proposals", {
      organizationId: ORG_A,
      eventId: created,
    }),
  );

  expect(response.status).toBe(200);

  const listed = (await response.json()).proposals;

  expect(listed).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: expired!.id, status: "EXPIRED" }),
    expect.objectContaining({ id: future!.id, status: "PENDING" }),
  ]));

  const [expiredAfter] = await ctx.db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, expired!.id));

  const [futureAfter] = await ctx.db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, future!.id));

  expect(expiredAfter!.status).toBe("EXPIRED");
  expect(futureAfter!.status).toBe("PENDING");
});


});

describe("AI flow: blueprint → generation status → proposal card → apply → event → sections", () => {
  it("runs end to end through the read endpoints the frontend polls", async () => {
    as(U.ownerA);
    const start = await blueprintRoute.POST(req("POST", { organizationId: ORG_A, prompt: "Nisan 2027'de Adana'da 3 günlük portakal çiçeği festivali, 20 bin kişi." }));
    expect(start.status).toBe(200);
    const generationId = start.headers.get("x-generation-id")!;
    await start.text(); // the client reads the stream

    // other tenants cannot see the generation; a member of the organization can
    as(U.ownerB);
    expect((await generationRoute.GET(get(`/api/ai/generations/${generationId}`, { organizationId: ORG_B }), P({ generationId }))).status).toBe(404);
    as(U.staffA);
    await drainAfter();
    const g = (await (await generationRoute.GET(get(`/api/ai/generations/${generationId}`, { organizationId: ORG_A }), P({ generationId }))).json()).generation;
    expect(g).toMatchObject({ id: generationId, kind: "blueprint.core", status: "SUCCEEDED", done: true });
    expect(g.proposals).toHaveLength(1);
    expect(g.proposals[0]).toMatchObject({ kind: "blueprint.core", status: "PENDING" });

    // the card is listed among pending, event-less proposals with its operations
    const cards = (await (await proposalsListRoute.GET(get("/api/proposals", { organizationId: ORG_A, eventId: "none", status: "PENDING" }))).json()).proposals;
    const card = cards.find((c: { id: string }) => c.id === g.proposals[0].id);
    expect(card).toMatchObject({ kind: "blueprint.core", status: "PENDING", eventId: null, generationId });
    expect(card.operations.length).toBeGreaterThan(0);
    as(U.ownerB);
    expect((await (await proposalsListRoute.GET(get("/api/proposals", { organizationId: ORG_B }))).json()).proposals.map((c: { id: string }) => c.id)).not.toContain(card.id);

    // apply → event created from the blueprint; it shows up in the events list and detail
    as(U.ownerA);
    const applied = await (await proposalRoute.POST(req("POST", { action: "apply", organizationId: ORG_A }), P({ proposalId: card.id }))).json();
    expect(applied.status).toBe("APPLIED");
    const eventId = applied.eventId as string;
    const list = (await (await eventsRoute.GET(get("/api/events", { organizationId: ORG_A }))).json()).events;
    expect(list.find((e: { id: string }) => e.id === eventId)).toMatchObject({ fromBlueprint: true, status: "draft" });
    const detail = (await (await eventRoute.GET(get(`/api/events/${eventId}`, { organizationId: ORG_A }), P({ eventId }))).json()).event;
    expect(detail.profile).toMatchObject({ format: "FESTIVAL", nuts2Code: "TR62" });
    expect((await (await proposalsListRoute.GET(get("/api/proposals", { organizationId: ORG_A, status: "APPLIED" }))).json()).proposals.map((c: { id: string }) => c.id)).toContain(card.id);

    // sections → one card per supported section for this event
    const queued = await sectionsRoute.POST(req("POST", { organizationId: ORG_A, eventId }));
    expect(queued.status).toBe(202);
    await drainAfter();
    const sectionCards = (await (await proposalsListRoute.GET(get("/api/proposals", { organizationId: ORG_A, eventId, status: "PENDING" }))).json()).proposals;
    expect(sectionCards.map((c: { kind: string }) => c.kind).sort()).toEqual(["blueprint.kpis", "blueprint.surveys", "blueprint.tasks"]);
    // apply the task card → tasks appear in the event counts
    const taskCard = sectionCards.find((c: { kind: string }) => c.kind === "blueprint.tasks");
    expect((await proposalRoute.POST(req("POST", { action: "apply", organizationId: ORG_A }), P({ proposalId: taskCard.id }))).status).toBe(200);
    const after = (await (await eventRoute.GET(get(`/api/events/${eventId}`, { organizationId: ORG_A }), P({ eventId }))).json()).event;
    expect(after.counts.tasks.TODO).toBeGreaterThan(0);
    expect(after.counts.pendingProposals).toBe(2);
  });

  it("validates query parameters (400) and hides other tenants' generations (404)", async () => {
    as(U.ownerA);
    expect((await proposalsListRoute.GET(get("/api/proposals", { organizationId: ORG_A, status: "DONE" }))).status).toBe(400);
    expect((await proposalsListRoute.GET(get("/api/proposals", { organizationId: ORG_A, eventId: "x" }))).status).toBe(400);
    const missing = "e0000000-0000-4000-8000-0000000000ff";
    expect((await generationRoute.GET(get(`/api/ai/generations/${missing}`, { organizationId: ORG_A }), P({ generationId: missing }))).status).toBe(404);
    as(null);
    expect((await proposalsListRoute.GET(get("/api/proposals", { organizationId: ORG_A }))).status).toBe(401);
  });
});

describe("attendees, QR tokens and check-in", () => {
  let ev = "";
  let evB = "";
  let tickets: { id: string; ticketType: string; qrToken: string }[] = [];
  beforeAll(async () => {
    [{ id: ev }] = (await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Kapı testi", status: "live", startDate: "2027-01-10" }).returning({ id: events.id })) as [{ id: string }];
    [{ id: evB }] = (await ctx.db.insert(events).values({ organizationId: ORG_B, title: "B kapı", status: "live", startDate: "2027-01-10" }).returning({ id: events.id })) as [{ id: string }];
  });

  it("POST attendees: owner/admin issue tickets with QR tokens; staff and other tenants cannot; nothing written on refusal", async () => {
    as(U.staffA);
    expect((await attendeesRoute.POST(req("POST", { organizationId: ORG_A, ticketType: "genel" }), P({ eventId: ev }))).status).toBe(403);
    as(U.ownerB);
    expect((await attendeesRoute.POST(req("POST", { organizationId: ORG_A, ticketType: "genel" }), P({ eventId: ev }))).status).toBe(403);
    as(U.ownerA);
    expect((await attendeesRoute.POST(req("POST", { organizationId: ORG_A, ticketType: "genel" }), P({ eventId: evB }))).status).toBe(404); // B's event via A's org
    expect((await attendeesRoute.POST(req("POST", { organizationId: ORG_A, ticketType: " ", quantity: 1 }), P({ eventId: ev }))).status).toBe(400);
    expect((await attendeesRoute.POST(req("POST", { organizationId: ORG_A, ticketType: "genel", quantity: 501 }), P({ eventId: ev }))).status).toBe(400);
    expect(await ctx.db.select().from(attendees).where(eq(attendees.eventId, ev))).toHaveLength(0);
    const r = await attendeesRoute.POST(req("POST", { organizationId: ORG_A, ticketType: "genel", quantity: 3 }), P({ eventId: ev }));
    expect(r.status).toBe(201);
    tickets = (await r.json()).attendees;
    expect(tickets).toHaveLength(3);
    for (const t of tickets) expect(t.qrToken).toMatch(/^[0-9a-f-]{36}$/);
    as(ADMIN_A);
    expect((await attendeesRoute.POST(req("POST", { organizationId: ORG_A, ticketType: "VIP" }), P({ eventId: ev }))).status).toBe(201);
  });

  it("GET attendees: owner/admin list without QR tokens; staff 403", async () => {
    as(ADMIN_A);
    const r = await attendeesRoute.GET(get(`/api/events/${ev}/attendees`, { organizationId: ORG_A }), P({ eventId: ev }));
    expect(r.status).toBe(200);
    const list = (await r.json()).attendees;
    expect(list).toHaveLength(4);
    expect(JSON.stringify(list)).not.toContain(tickets[0]!.qrToken);
    expect(Object.keys(list[0]).sort()).toEqual(["cancelledAt", "checkedInAt", "createdAt", "id", "isCheckedIn", "ticketType"]);
    as(U.staffA);
    expect((await attendeesRoute.GET(get(`/api/events/${ev}/attendees`, { organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
    as(U.ownerA);
    expect((await attendeesRoute.GET(get(`/api/events/${evB}/attendees`, { organizationId: ORG_A }), P({ eventId: evB }))).status).toBe(404);
  });

  it("GET qr: owner/admin read an attendee's token; staff 403; wrong event 404", async () => {
    const t = tickets[0]!;
    as(U.ownerA);
    const r = await qrRoute.GET(get(`/api/events/${ev}/attendees/${t.id}/qr`, { organizationId: ORG_A }), P({ eventId: ev, attendeeId: t.id }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ attendeeId: t.id, ticketType: "genel", qrToken: t.qrToken, cancelledAt: null });
    expect((await qrRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: evB, attendeeId: t.id }))).status).toBe(404);
    as(U.staffA);
    expect((await qrRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev, attendeeId: t.id }))).status).toBe(403);
  });

  it("POST checkin: staff scans a ticket once (200), a second scan is 409 with the first time; unknown/foreign tokens are 404", async () => {
    const t = tickets[0]!;
    as(U.staffA);
    const r = await checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: t.qrToken }), P({ eventId: ev }));
    expect(r.status).toBe(200);
    const first = await r.json();
    expect(first).toMatchObject({ status: "CHECKED_IN", attendeeId: t.id, ticketType: "genel" });
    const again = await checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: t.qrToken }), P({ eventId: ev }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "ALREADY_CHECKED_IN", attendeeId: t.id, checkedInAt: first.checkedInAt });
    for (const token of ["not-a-uuid", "e0000000-0000-4000-8000-0000000000ff"])
      expect(await (await checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: token }), P({ eventId: ev }))).json()).toMatchObject({ code: "UNKNOWN_TICKET" });
    // a valid token of this event scanned at another event of the same organization is unknown there
    const [{ id: other }] = (await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Başka kapı" }).returning({ id: events.id })) as [{ id: string }];
    expect((await checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: tickets[1]!.qrToken }), P({ eventId: other }))).status).toBe(404);
    // another tenant cannot check A's tickets in, neither through A's org nor through its own
    as(U.ownerB);
    expect((await checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: tickets[1]!.qrToken }), P({ eventId: ev }))).status).toBe(403);
    expect((await checkinRoute.POST(req("POST", { organizationId: ORG_B, qrToken: tickets[1]!.qrToken }), P({ eventId: evB }))).status).toBe(404);
    const [row] = await ctx.db.select().from(attendees).where(eq(attendees.id, tickets[1]!.id));
    expect(row!.isCheckedIn).toBe(false);
  });

  it("concurrent scans of the same ticket: exactly one succeeds", async () => {
    as(U.staffA);
    const t = tickets[2]!;
    const results = await Promise.all([0, 1, 2].map(() => checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: t.qrToken }), P({ eventId: ev }))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  it("no check-in at a completed event (409)", async () => {
    const [{ id: done }] = (await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Bitti", status: "completed", startDate: "2026-01-01" }).returning({ id: events.id })) as [{ id: string }];
    const [a] = await ctx.db.insert(attendees).values({ organizationId: ORG_A, eventId: done, ticketType: "genel" }).returning();
    as(U.staffA);
    const r = await checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: a!.qrUuid }), P({ eventId: done }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "EVENT_COMPLETED" });
  });

  it("GET checkins summary: totals, per ticket type, latest check-ins (staff may read)", async () => {
    as(U.staffA);
    const r = await checkinsRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }));
    expect(r.status).toBe(200);
    const { summary } = await r.json();
    expect(summary).toMatchObject({ eventId: ev, total: 4, checkedIn: 2 });
    expect(summary.byTicketType).toEqual(expect.arrayContaining([{ ticketType: "genel", total: 3, checkedIn: 2 }, { ticketType: "VIP", total: 1, checkedIn: 0 }]));
    expect(summary.byTicketType).toHaveLength(2);
    expect(summary.recent.map((x: { attendeeId: string }) => x.attendeeId).sort()).toEqual([tickets[0]!.id, tickets[2]!.id].sort());
    as(U.ownerB);
    expect((await checkinsRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
  });

  it("SSE stream: first a summary, then each new check-in and the updated counts; stops on abort", async () => {
    process.env.CHECKIN_STREAM_INTERVAL_MS = "30";
    process.env.CHECKIN_STREAM_MAX_MS = "20000";
    as(U.staffA);
    const abort = new AbortController();
    const r = await streamRoute.GET(new Request(url(`/api/events/${ev}/checkins/stream`, { organizationId: ORG_A }), { signal: abort.signal }), P({ eventId: ev }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const nextEvent = async (): Promise<{ event: string; data: unknown }> => {
      for (;;) {
        const m = buf.match(/event: (\w+)\ndata: (.*)\n\n/);
        if (m) { buf = buf.slice(m.index! + m[0].length); return { event: m[1]!, data: JSON.parse(m[2]!) }; }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value);
      }
    };
    expect(await nextEvent()).toMatchObject({ event: "summary", data: { total: 4, checkedIn: 2 } });
    // a door scan happens while the dashboard is open
    expect((await checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: tickets[1]!.qrToken }), P({ eventId: ev }))).status).toBe(200);
    expect(await nextEvent()).toMatchObject({ event: "checkin", data: { attendeeId: tickets[1]!.id, ticketType: "genel" } });
    expect(await nextEvent()).toMatchObject({ event: "summary", data: { total: 4, checkedIn: 3 } });
    // a ticket issued at the box office changes the total
    as(U.ownerA);
    await attendeesRoute.POST(req("POST", { organizationId: ORG_A, ticketType: "VIP" }), P({ eventId: ev }));
    expect(await nextEvent()).toMatchObject({ event: "summary", data: { total: 5, checkedIn: 3 } });
    abort.abort();
    for (;;) { const { done } = await reader.read(); if (done) break; }
  });

  it("SSE stream: authorisation is checked before streaming (403 / 404 / 401)", async () => {
    as(U.ownerB);
    expect((await streamRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
    expect((await streamRoute.GET(get("", { organizationId: ORG_B }), P({ eventId: ev }))).status).toBe(404);
    as(null);
    expect((await streamRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(401);
  });

  it("cancel ticket: excludes it from counts and rejects a later scan", async () => {
    const [target] = await ctx.db.insert(attendees).values({
      organizationId: ORG_A,
      eventId: ev,
      ticketType: "cancel-test",
    }).returning();

    // Confirm the ticket exists in the total before cancellation.
    as(U.staffA);
    const beforeResponse = await checkinsRoute.GET(
      get("", { organizationId: ORG_A }),
      P({ eventId: ev }),
    );
    expect(beforeResponse.status).toBe(200);
    const beforeTotal = (await beforeResponse.json()).summary.total;

    // Owner cancels the ticket.
    as(U.ownerA);
    const cancelResponse = await cancelAttendeesRoute.POST(
      req("POST", {
        organizationId: ORG_A,
        attendeeIds: [target!.id],
      }),
      P({ eventId: ev }),
    );

    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toEqual({
      cancelled: [target!.id],
      alreadyCancelled: [],
      checkedIn: [],
      notFound: [],
    });

    // Scanning the cancelled ticket must fail.
    as(U.staffA);
    const scanResponse = await checkinRoute.POST(
      req("POST", {
        organizationId: ORG_A,
        qrToken: target!.qrUuid,
      }),
      P({ eventId: ev }),
    );

    expect(scanResponse.status).toBe(409);
    expect(await scanResponse.json()).toMatchObject({
      code: "TICKET_CANCELLED",
    });

    // Cancelled tickets no longer count toward the total.
    const afterResponse = await checkinsRoute.GET(
      get("", { organizationId: ORG_A }),
      P({ eventId: ev }),
    );
    expect(afterResponse.status).toBe(200);
    expect((await afterResponse.json()).summary.total).toBe(beforeTotal - 1);
  });

  it("undo check-in: restricts staff and reverses an owner's check-in", async () => {
    const [target] = await ctx.db.insert(attendees).values({
      organizationId: ORG_A,
      eventId: ev,
      ticketType: "undo-test",
      isCheckedIn: true,
      checkedInAt: new Date(),
    }).returning();

    // Staff may scan tickets but cannot use the undo endpoint.
    as(U.staffA);
    const denied = await undoCheckinRoute.POST(
      req("POST", {
        organizationId: ORG_A,
        attendeeId: target!.id,
      }),
      P({ eventId: ev }),
    );
    expect(denied.status).toBe(403);

    // Owner can reverse the mistaken check-in.
    as(U.ownerA);
    const response = await undoCheckinRoute.POST(
      req("POST", {
        organizationId: ORG_A,
        attendeeId: target!.id,
      }),
      P({ eventId: ev }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "CHECK_IN_REVERSED",
      attendeeId: target!.id,
    });

    const [row] = await ctx.db
      .select({
        isCheckedIn: attendees.isCheckedIn,
        checkedInAt: attendees.checkedInAt,
      })
      .from(attendees)
      .where(eq(attendees.id, target!.id));

    expect(row).toMatchObject({
      isCheckedIn: false,
      checkedInAt: null,
    });

    // Undoing it again must return a conflict.
    const repeated = await undoCheckinRoute.POST(
      req("POST", {
        organizationId: ORG_A,
        attendeeId: target!.id,
      }),
      P({ eventId: ev }),
    );

    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      code: "NOT_CHECKED_IN",
    });
  });

it("GET tickets: returns QR SVGs, serves a single SVG, and excludes cancelled tickets", async () => {
  const [target] = await ctx.db.insert(attendees).values({
    organizationId: ORG_A,
    eventId: ev,
    ticketType: "print-test",
  }).returning();

  as(U.ownerA);

  // Fetch the printable ticket list.
  const response = await ticketsRoute.GET(
    get(`/api/events/${ev}/tickets`, {
      organizationId: ORG_A,
    }),
    P({ eventId: ev }),
  );

  expect(response.status).toBe(200);

  const body = await response.json();
  const ticket = body.tickets.find(
    (item: { attendeeId: string }) => item.attendeeId === target!.id,
  );

  expect(ticket).toBeDefined();
  expect(ticket.qrToken).toBe(target!.qrUuid);
  expect(ticket.qrSvg).toContain("<svg");

  // Request the selected ticket as a standalone SVG image.
  const svgResponse = await ticketsRoute.GET(
    get(`/api/events/${ev}/tickets`, {
      organizationId: ORG_A,
      attendeeId: target!.id,
      format: "svg",
    }),
    P({ eventId: ev }),
  );

  expect(svgResponse.status).toBe(200);
  expect(svgResponse.headers.get("content-type")).toContain("image/svg+xml");
  expect(await svgResponse.text()).toContain("<svg");

  // Cancel the ticket and make sure it disappears from printable tickets.
  const cancelResponse = await cancelAttendeesRoute.POST(
    req("POST", {
      organizationId: ORG_A,
      attendeeIds: [target!.id],
    }),
    P({ eventId: ev }),
  );

  expect(cancelResponse.status).toBe(200);

  const afterCancel = await ticketsRoute.GET(
    get(`/api/events/${ev}/tickets`, {
      organizationId: ORG_A,
    }),
    P({ eventId: ev }),
  );

  expect(afterCancel.status).toBe(200);

  const updatedBody = await afterCancel.json();
  expect(
    updatedBody.tickets.some(
      (item: { attendeeId: string }) => item.attendeeId === target!.id,
    ),
  ).toBe(false);

  // A cancelled ticket must not return an SVG.
  const cancelledSvg = await ticketsRoute.GET(
    get(`/api/events/${ev}/tickets`, {
      organizationId: ORG_A,
      attendeeId: target!.id,
      format: "svg",
    }),
    P({ eventId: ev }),
  );

  expect(cancelledSvg.status).toBe(404);

  // Staff cannot access the ticket-printing endpoint.
  as(U.staffA);

  const denied = await ticketsRoute.GET(
    get(`/api/events/${ev}/tickets`, {
      organizationId: ORG_A,
    }),
    P({ eventId: ev }),
  );

  expect(denied.status).toBe(403);
});


});

describe("tasks, KPIs and impact readiness", () => {
  let ev = "";
  let taskId = "";
  beforeAll(async () => {
    [{ id: ev }] = (await ctx.db.insert(events).values({
      organizationId: ORG_A, title: "Portakal Çiçeği", status: "live", startDate: "2027-04-20",
      aiConfig: { event: { format: "FESTIVAL", nuts2Code: "TR62", expectedAttendance: 20000 } }, aiConfigVersion: "blueprint/v1",
    }).returning({ id: events.id })) as [{ id: string }];
    [{ id: taskId }] = (await ctx.db.insert(tasks).values({ organizationId: ORG_A, eventId: ev, title: "Valilik izin başvurusu", priority: "CRITICAL" } as never).returning({ id: tasks.id })) as [{ id: string }];
    await ctx.db.insert(eventKpis).values({ organizationId: ORG_A, eventId: ev, metricName: "overall_satisfaction", dataSource: "survey" } as never);
  });

  it("GET tasks / kpis: members read their event's tasks and KPIs; other tenants get 403 / nothing", async () => {
    as(U.staffA);
    const t = (await (await tasksRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }))).json()).tasks;
    expect(t).toEqual([expect.objectContaining({ id: taskId, title: "Valilik izin başvurusu", status: "TODO", priority: "CRITICAL" })]);
    const k = (await (await kpisRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }))).json()).kpis;
    expect(k).toEqual([expect.objectContaining({ metricName: "overall_satisfaction", dataSource: "survey", status: "PROPOSED" })]);
    as(U.ownerB);
    expect((await tasksRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
    expect((await (await tasksRoute.GET(get("", { organizationId: ORG_B }), P({ eventId: ev }))).json()).tasks).toEqual([]);
  });

it("PATCH KPI: owner updates the decision and target; staff and other tenants are denied", async () => {
  const [kpi] = await ctx.db
    .select({ id: eventKpis.id })
    .from(eventKpis)
    .where(eq(eventKpis.eventId, ev));

  expect(kpi).toBeDefined();

  // Staff cannot make an organizer's KPI decision.
  as(U.staffA);
  const denied = await kpiDecisionRoute.PATCH(
    req("PATCH", {
      organizationId: ORG_A,
      status: "ACTIVE",
      targetValue: 250,
    }),
    P({ kpiId: kpi!.id }),
  );
  expect(denied.status).toBe(403);

  // overall_satisfaction is computed by the KPI engine: a typed actual is refused.
  as(U.ownerA);
  const typed = await kpiDecisionRoute.PATCH(
    req("PATCH", { organizationId: ORG_A, actualValue: 999 }),
    P({ kpiId: kpi!.id }),
  );
  expect(typed.status).toBe(422);
  expect(await typed.json()).toMatchObject({ code: "KPI_COMPUTED" });

  // Owner can activate the KPI and set its target.
  const response = await kpiDecisionRoute.PATCH(
    req("PATCH", {
      organizationId: ORG_A,
      status: "ACTIVE",
      targetValue: 250,
    }),
    P({ kpiId: kpi!.id }),
  );

  expect(response.status).toBe(200);
  const body = await response.json();

  expect(body.kpi.status).toBe("ACTIVE");
  expect(Number(body.kpi.targetValue)).toBe(250);
  expect(body.kpi.actualValue).toBeNull();

  // Another organization's owner cannot update this KPI.
  as(U.ownerB);
  const foreign = await kpiDecisionRoute.PATCH(
    req("PATCH", {
      organizationId: ORG_B,
      status: "DROPPED",
    }),
    P({ kpiId: kpi!.id }),
  );
  expect(foreign.status).toBe(404);

  // The foreign request must not have changed the original KPI.
  as(U.ownerA);
  const [saved] = await ctx.db
    .select({
      status: eventKpis.status,
      targetValue: eventKpis.targetValue,
    })
    .from(eventKpis)
    .where(eq(eventKpis.id, kpi!.id));

  expect(saved?.status).toBe("ACTIVE");
  expect(Number(saved?.targetValue)).toBe(250);
});


  it("PATCH task status: staff moves a task (RLS + column privilege); other tenants 403/404; invalid status 400", async () => {
    as(U.staffA);
    const r = await taskRoute.PATCH(req("PATCH", { organizationId: ORG_A, status: "IN_PROGRESS" }), P({ taskId }));
    expect(r.status).toBe(200);
    expect((await r.json()).task).toMatchObject({ id: taskId, status: "IN_PROGRESS" });
    expect((await taskRoute.PATCH(req("PATCH", { organizationId: ORG_A, status: "BLOCKED" }), P({ taskId }))).status).toBe(400);
    as(U.ownerB);
    expect((await taskRoute.PATCH(req("PATCH", { organizationId: ORG_A, status: "DONE" }), P({ taskId }))).status).toBe(403);
    expect((await taskRoute.PATCH(req("PATCH", { organizationId: ORG_B, status: "DONE" }), P({ taskId }))).status).toBe(404);
    const [row] = await ctx.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
    expect(row!.status).toBe("IN_PROGRESS");
  });

  it("GET impact: the sufficiency gate on real data; no figure; attendance basis follows the data", async () => {
    as(U.staffA);
    let r = await impactRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }));
    expect(r.status).toBe(200);
    let { impact } = await r.json();
    expect(impact).toMatchObject({
      eventId: ev, figures: null,
      inputs: { attendance: { basis: "ORGANIZER_ESTIMATE", value: 20000 }, eventNuts2Code: "TR62", responses: { nonResidentWithSpend: 0, withAttributionAnswers: 0 } },
      assessment: { requestedLevel: "ECONOMIC_IMPACT", achievedLevel: null, status: "INSUFFICIENT_DATA" },
    });
    expect(new Set(impact.assessment.checks.map((c: { level: string }) => c.level))).toEqual(new Set(["SPEND", "ATTRIBUTABLE_SPEND", "ECONOMIC_IMPACT"]));
    expect(impact.assessment.checks.find((c: { check: string }) => c.check === "attendance_known").passed).toBe(true);
    expect(impact.dataNotes.length).toBeGreaterThan(0);

    // tickets issued → registrations; a check-in → measured attendance
    const [a] = await ctx.db.insert(attendees).values([{ organizationId: ORG_A, eventId: ev, ticketType: "genel" }, { organizationId: ORG_A, eventId: ev, ticketType: "genel" }]).returning();
    ({ impact } = await (await impactRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }))).json());
    expect(impact.inputs.attendance).toEqual({ basis: "REGISTRATION", value: 2 });
    await checkinRoute.POST(req("POST", { organizationId: ORG_A, qrToken: a!.qrUuid }), P({ eventId: ev }));
    r = await impactRoute.GET(get("", { organizationId: ORG_A, level: "SPEND" }), P({ eventId: ev }));
    ({ impact } = await r.json());
    expect(impact.inputs.attendance).toEqual({ basis: "CHECKIN", value: 1 });
    expect(impact.assessment.checks.every((c: { level: string }) => c.level === "SPEND")).toBe(true);
    expect(impact.assessment.achievedLevel).toBeNull();
  });

  it("GET impact: 400 for an unknown level, 404 for another tenant's event, 401 without a session", async () => {
    as(U.ownerA);
    expect((await impactRoute.GET(get("", { organizationId: ORG_A, level: "GDP" }), P({ eventId: ev }))).status).toBe(400);
    as(U.ownerB);
    expect((await impactRoute.GET(get("", { organizationId: ORG_B }), P({ eventId: ev }))).status).toBe(404);
    as(null);
    expect((await impactRoute.GET(get("", { organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(401);
  });

it("impact runs: creates a run, allows same-org reads, and blocks other tenants", async () => {
  // Staff can read impact data but cannot create an impact run.
  as(U.staffA);

  const denied = await impactRunsRoute.POST(
    req("POST", {
      organizationId: ORG_A,
      level: "ECONOMIC_IMPACT",
    }),
    P({ eventId: ev }),
  );

  expect(denied.status).toBe(403);

  // Owner creates a stored impact run.
  as(U.ownerA);

  const created = await impactRunsRoute.POST(
    req("POST", {
      organizationId: ORG_A,
      level: "ECONOMIC_IMPACT",
    }),
    P({ eventId: ev }),
  );

  expect(created.status).toBe(201);

  const { run } = await created.json();

  expect(run).toMatchObject({
    id: expect.any(String),
    eventId: ev,
    requestedLevel: "ECONOMIC_IMPACT",
    achievedLevel: null,
    status: "INSUFFICIENT_DATA",
    figures: null,
  });

  // Another member of the same organization can read the stored run.
  as(U.staffA);

  const detail = await impactRunRoute.GET(
    get(`/api/impact-runs/${run.id}`, {
      organizationId: ORG_A,
    }),
    P({ runId: run.id }),
  );

  expect(detail.status).toBe(200);

  const detailBody = await detail.json();
  expect(detailBody.run).toMatchObject({
    id: run.id,
    eventId: ev,
    requestedLevel: "ECONOMIC_IMPACT",
  });

  // A different organization's owner cannot read this run.
  as(U.ownerB);

  const foreign = await impactRunRoute.GET(
    get(`/api/impact-runs/${run.id}`, {
      organizationId: ORG_B,
    }),
    P({ runId: run.id }),
  );

  expect(foreign.status).toBe(404);
});

});
