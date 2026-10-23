/**
 * The four API routes after the step-6 switch (requireOrgPermission + Drizzle services), called as
 * Route Handlers with real Request objects on PGlite (0000–0005).
 *  - Sign-in is simulated at the getUserDb() seam: the membership lookup itself runs under real RLS.
 *  - after() is captured so background work (core finalisation, sections) can be awaited.
 *  - The model is a mock provider behind the real AI SDK.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiGenerations, events, proposals, tasks, users } from "@/db/schema";
import { ORG_A, ORG_B, setupDb, U } from "./helpers";
import { coreExample, respondWith, type MockState } from "./ai-mocks";

const h = vi.hoisted(() => ({
  db: null as unknown,
  user: null as string | null,
  after: [] as (() => unknown)[],
  ai: { respond: () => "{}", calls: [] } as unknown as MockState,
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { h.after.push(fn); } }));
vi.mock("@/db", async () => {
  const { withRls } = await import("@/db/rls");
  class UnauthenticatedError extends Error {}
  return {
    UnauthenticatedError,
    getUserDb: async () => {
      if (!h.user) throw new UnauthenticatedError("Not signed in");
      const sub = h.user;
      return <T,>(fn: Parameters<typeof withRls<T>>[2]) => withRls(h.db as never, { sub }, fn);
    },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});
vi.mock("@/server/ai/models", async (orig) => {
  const real = await orig<typeof import("@/server/ai/models")>();
  const { mockModel } = await import("./ai-mocks");
  // the provider key check is exercised separately; here the model is the mock
  return { ...real, modelFor: () => mockModel(h.ai), assertAiConfigured: () => {} };
});

const blueprintRoute = await import("@/app/api/ai/blueprint/route");
const sectionsRoute = await import("@/app/api/ai/blueprint/sections/route");
const proposalsRoute = await import("@/app/api/proposals/[proposalId]/route");
const eventBuilderRoute = await import("@/app/api/ai/event-builder/route");
const generationRoute = await import("@/app/api/ai/generations/[generationId]/route");

let ctx: Awaited<ReturnType<typeof setupDb>>;
const ADMIN_A = "a0000000-0000-4000-8000-000000000003";
let eventA = "";
let eventB = "";
let plainEventA = "";

const post = (body: unknown) => new Request("http://test.local/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const as = (user: string | null) => { h.user = user; };
const drainAfter = async () => { while (h.after.length) await h.after.shift()!(); };
const generationsFor = async (org: string) => ctx.db.select().from(aiGenerations).where(eq(aiGenerations.organizationId, org));
const proposalRow = async (id: string) => (await ctx.db.select().from(proposals).where(eq(proposals.id, id)))[0]!;
const decide = (proposalId: string, body: object) => proposalsRoute.POST(post(body), { params: Promise.resolve({ proposalId }) });

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  await ctx.pg.query("insert into auth.users (id, email) values ($1, 'adminA@example.com')", [ADMIN_A]);
  await ctx.db.insert(users).values({ id: ADMIN_A, organizationId: ORG_A, email: "adminA@example.com", role: "admin" });
  [{ id: eventB }] = await ctx.db.insert(events).values({ organizationId: ORG_B, title: "B etkinliği" }).returning({ id: events.id }) as [{ id: string }];
  [{ id: plainEventA }] = await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Elle açılan" }).returning({ id: events.id }) as [{ id: string }];
  const core = await coreExample();
  h.ai.respond = respondWith({}, core);
}, 60_000);

describe("POST /api/ai/blueprint (blueprint.generate)", () => {
  const body = { organizationId: ORG_A, prompt: "Nisan 2027'de Adana'da 3 günlük portakal çiçeği festivali, 20 bin kişi." };

  it("401 when not signed in; 403 for staff and for members of another organization; nothing recorded", async () => {
    const before = (await generationsFor(ORG_A)).length;
    as(null);
    expect((await blueprintRoute.POST(post(body))).status).toBe(401);
    as(U.staffA);
    const r = await blueprintRoute.POST(post(body));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "Insufficient role" });
    as(U.ownerB);
    expect((await blueprintRoute.POST(post(body))).status).toBe(403);
    expect((await generationsFor(ORG_A)).length).toBe(before);
    expect(h.after).toHaveLength(0);
  });

  it("400 for an invalid body", async () => {
    as(U.ownerA);
    expect((await blueprintRoute.POST(post({ organizationId: ORG_A, prompt: "kısa" }))).status).toBe(400);
  });

  it("owner: streams, records the generation in the verified org, and leaves a PENDING core proposal (no event)", async () => {
    as(U.ownerA);
    const eventsBefore = (await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length;
    const res = await blueprintRoute.POST(post(body));
    expect(res.status).toBe(200);
    const generationId = res.headers.get("x-generation-id")!;
    expect(generationId).toMatch(/^[0-9a-f-]{36}$/);
    await res.text();
    await drainAfter();
    const [g] = await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, generationId));
    expect(g).toMatchObject({ organizationId: ORG_A, requestedBy: U.ownerA, kind: "blueprint.core", status: "SUCCEEDED", eventId: null });
    const [p] = await ctx.db.select().from(proposals).where(eq(proposals.generationId, generationId));
    expect(p).toMatchObject({ status: "PENDING", kind: "blueprint.core", organizationId: ORG_A, requestedBy: U.ownerA, eventId: null });
    expect((await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length).toBe(eventsBefore);
  });
});

describe("plan proposal when the model fails", () => {
  const body = { organizationId: ORG_A, prompt: "Coca-Cola sponsorluğunda bir gençlik festivali düzenleyeceğim." };
  const generation = async (id: string) =>
    (await (await generationRoute.GET(new Request(`http://test.local/api?organizationId=${ORG_A}`), { params: Promise.resolve({ generationId: id }) })).json()).generation;

  it("the main model busy: the same request runs once on the fallback model and the proposal is made; Gemini thinks at a low level", async () => {
    const normal = h.ai.respond;
    let n = 0;
    h.ai.respond = (system) => (n++ === 0 ? new Error("503 UNAVAILABLE: The model is overloaded. Please try again later.") : normal(system));
    h.ai.calls.length = 0;
    as(U.ownerA);
    const res = await blueprintRoute.POST(post(body));
    const id = res.headers.get("x-generation-id")!;
    await res.text();
    await drainAfter();
    h.ai.respond = normal;
    const g = await generation(id);
    expect(g).toMatchObject({ status: "SUCCEEDED", failure: null, proposals: [{ kind: "blueprint.core" }] });
    expect(g.output.fallback).toMatchObject({ after: { kind: "overloaded" } });
    expect(h.ai.calls).toHaveLength(2);
    expect((h.ai.calls[0] as { providerOptions?: unknown }).providerOptions).toMatchObject({ google: { thinkingConfig: { thinkingLevel: "low" } } });
    expect((h.ai.calls[1] as { providerOptions?: { google?: unknown } }).providerOptions?.google).toBeUndefined();
  });

  it("an invalid key: no pointless retry; the organizer is told what to fix, without the key", async () => {
    const normal = h.ai.respond;
    h.ai.respond = () => new Error("API key not valid. Please pass a valid API key. https://x.test/v1beta?key=AIzaSyFAKEFAKEFAKEFAKE123456");
    h.ai.calls.length = 0;
    as(U.ownerA);
    const res = await blueprintRoute.POST(post(body));
    const id = res.headers.get("x-generation-id")!;
    await res.text();
    await drainAfter();
    h.ai.respond = normal;
    const g = await generation(id);
    expect(h.ai.calls).toHaveLength(1);
    expect(g).toMatchObject({ status: "FAILED_PROVIDER", failure: { kind: "auth", text: expect.stringMatching(/anahtar/) } });
    expect(JSON.stringify(g)).not.toContain("AIzaSyFAKE");
    const [row] = await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, id));
    expect(JSON.stringify(row!.validationErrors)).not.toContain("AIzaSyFAKE");
  });

  it("both models fail (quota): both attempts are kept and the quota message is shown", async () => {
    const normal = h.ai.respond;
    h.ai.respond = () => new Error("429 RESOURCE_EXHAUSTED: You exceeded your current quota");
    as(U.ownerA);
    const res = await blueprintRoute.POST(post(body));
    const id = res.headers.get("x-generation-id")!;
    await res.text();
    await drainAfter();
    h.ai.respond = normal;
    const g = await generation(id);
    expect(g).toMatchObject({ status: "FAILED_PROVIDER", quotaExceeded: true, failure: { kind: "quota" } });
    expect(g.validationErrors.attempts).toHaveLength(2);
  });
});

describe("POST /api/proposals/:id (proposal.decide)", () => {
  let coreId = "";
  let coreGen = "";
  beforeAll(async () => {
    const [p] = await ctx.db.select().from(proposals).where(and(eq(proposals.organizationId, ORG_A), eq(proposals.kind, "blueprint.core")));
    coreId = p!.id;
    coreGen = p!.generationId!;
  });

  it("400 for a bad id; 403 for staff (nothing changes); 404 when the organization does not own the proposal", async () => {
    as(U.ownerA);
    expect((await proposalsRoute.POST(post({ action: "apply", organizationId: ORG_A }), { params: Promise.resolve({ proposalId: "nope" }) })).status).toBe(400);
    as(U.staffA);
    // Refused by the route's permission check itself (the service would also refuse, with a different body).
    const r = await decide(coreId, { action: "apply", organizationId: ORG_A });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "Insufficient role" });
    const rj = await decide(coreId, { action: "reject", organizationId: ORG_A });
    expect(rj.status).toBe(403);
    expect(await rj.json()).toEqual({ error: "Insufficient role" });
    expect((await proposalRow(coreId)).status).toBe("PENDING");
    as(U.ownerB);
    const nf = await decide(coreId, { action: "apply", organizationId: ORG_B });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "Proposal not found", code: "NOT_FOUND" });
    expect((await proposalRow(coreId)).status).toBe("PENDING");
  });

  it("apply: API says APPLIED, the DB says APPROVED, the generation is APPLIED and linked; a second apply is 409", async () => {
    as(ADMIN_A);
    const r = await decide(coreId, { action: "apply", organizationId: ORG_A });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json).toMatchObject({ status: "APPLIED", applied: 1, created: { event: 1 } });
    eventA = json.eventId;
    expect(await proposalRow(coreId)).toMatchObject({ status: "APPROVED", decidedBy: ADMIN_A, eventId: eventA });
    expect((await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, coreGen)))[0]).toMatchObject({ status: "APPLIED", eventId: eventA });
    const again = await decide(coreId, { action: "apply", organizationId: ORG_A });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "Proposal is APPLIED", code: "NOT_PENDING" });
  });

  it("a stored proposal with an unsupported operation is 422 and changes nothing", async () => {
    const [p] = await ctx.db.insert(proposals).values({
      organizationId: ORG_A, eventId: eventA, kind: "blueprint.budget_risks", title: "Bütçe", schemaVersion: "blueprint/v1",
      payload: { operations: [{ op: "upsert", entity: "risk", data: { key: "rain", title: "Yağmur", description: null, category: "weather", likelihood: 3, impact: 3, mitigation: null, ownerRole: null } }] },
      aiFingerprint: "a".repeat(64), expiresAt: new Date(Date.now() + 86_400_000),
    }).returning();
    as(U.ownerA);
    const r = await decide(p!.id, { action: "apply", organizationId: ORG_A });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ code: "INVALID", error: expect.stringMatching(/risk/) });
    expect(await proposalRow(p!.id)).toMatchObject({ status: "PENDING", errorMessage: null, decidedAt: null });
  });

  it("reject: API and DB both say REJECTED", async () => {
    const [p] = await ctx.db.insert(proposals).values({
      organizationId: ORG_A, eventId: eventA, kind: "blueprint.tasks", title: "Görevler", schemaVersion: "blueprint/v1",
      payload: { operations: [] }, aiFingerprint: "b".repeat(64), expiresAt: new Date(Date.now() + 86_400_000),
    }).returning();
    as(U.ownerA);
    const r = await decide(p!.id, { action: "reject", organizationId: ORG_A });
    expect(await r.json()).toEqual({ status: "REJECTED" });
    expect(await proposalRow(p!.id)).toMatchObject({ status: "REJECTED", decidedBy: U.ownerA });
  });
});

describe("POST /api/ai/blueprint/sections (blueprint.generate)", () => {
  it("403 for staff; nothing queued", async () => {
    as(U.staffA);
    expect((await sectionsRoute.POST(post({ organizationId: ORG_A, eventId: eventA }))).status).toBe(403);
    expect(h.after).toHaveLength(0);
  });

  it("422 with a clear message when an unsupported section is requested; nothing queued", async () => {
    as(U.ownerA);
    for (const sections of [["registration"], ["tasks", "budget_risks"]]) {
      const r = await sectionsRoute.POST(post({ organizationId: ORG_A, eventId: eventA, sections }));
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({
        code: "INVALID",
        error: `Desteklenmeyen bölüm: ${sections.filter((s) => s !== "tasks").join(", ")}. Bu bölümler henüz uygulanamadığı için üretilmiyor.`,
      });
    }
    expect(h.after).toHaveLength(0);
  });

  it("404 for another organization's or a missing event; 409 for an event not created from a Blueprint", async () => {
    as(U.ownerA);
    expect((await sectionsRoute.POST(post({ organizationId: ORG_A, eventId: eventB }))).status).toBe(404);
    expect((await sectionsRoute.POST(post({ organizationId: ORG_A, eventId: "0f000000-0000-4000-8000-00000000000f" }))).status).toBe(404);
    expect((await sectionsRoute.POST(post({ organizationId: ORG_A, eventId: plainEventA }))).status).toBe(409);
    expect(h.after).toHaveLength(0);
  });

  it("202: supported sections queued, unsupported ones listed as such; the queued work produces the cards", async () => {
    as(U.ownerA);
    const r = await sectionsRoute.POST(post({ organizationId: ORG_A, eventId: eventA }));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: "queued", eventId: eventA,
      sections: { tasks: "queued", kpis: "queued", surveys: "queued", registration: "unsupported", budget_risks: "unsupported" } });
    await drainAfter();
    // AI-generated cards only (the hand-inserted unsupported proposal above has no generation)
    const kinds = (await ctx.db.select().from(proposals)
      .where(and(eq(proposals.eventId, eventA), eq(proposals.status, "PENDING"), isNotNull(proposals.generationId)))).map((p) => p.kind).sort();
    expect(kinds).toEqual(["blueprint.kpis", "blueprint.surveys", "blueprint.tasks"]);
    expect(await ctx.db.select().from(tasks).where(eq(tasks.eventId, eventA))).toEqual([]);

    const only = await sectionsRoute.POST(post({ organizationId: ORG_A, eventId: eventA, sections: ["tasks"] }));
    expect(await only.json()).toEqual({ status: "queued", eventId: eventA, sections: { tasks: "queued" } });
    h.after.length = 0;
  });
});

describe("POST /api/ai/event-builder (blueprint.generate)", () => {
  const body = (eventId?: string) => ({ organizationId: ORG_A, prompt: "Etkinliği güncelle", ...(eventId ? { eventId } : {}) });

  it("403 for staff", async () => {
    as(U.staffA);
    expect((await eventBuilderRoute.POST(post(body()))).status).toBe(403);
  });

  it("404 for another organization's or a missing event: no generation recorded, the other event untouched", async () => {
    as(U.ownerA);
    const [bBefore] = await ctx.db.select().from(events).where(eq(events.id, eventB));
    const genA = (await generationsFor(ORG_A)).length;
    const genB = (await generationsFor(ORG_B)).length;
    for (const id of [eventB, "0f000000-0000-4000-8000-00000000000f"]) {
      const r = await eventBuilderRoute.POST(post(body(id)));
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "Event not found" });
    }
    expect((await generationsFor(ORG_A)).length).toBe(genA);
    expect((await generationsFor(ORG_B)).length).toBe(genB);
    expect((await ctx.db.select().from(events).where(eq(events.id, eventB)))[0]).toEqual(bBefore);
    expect(h.after).toHaveLength(0);
  });

  it("own event: generation recorded in the verified org with the event, then finished in the background", async () => {
    as(U.ownerA);
    const r = await eventBuilderRoute.POST(post(body(eventA)));
    expect(r.status).toBe(200);
    const id = r.headers.get("x-generation-id")!;
    await r.text();
    await drainAfter();
    const [g] = await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, id));
    expect(g).toMatchObject({ organizationId: ORG_A, requestedBy: U.ownerA, eventId: eventA, kind: "event_config" });
    expect(g!.status).not.toBe("STREAMING");
  });
});
