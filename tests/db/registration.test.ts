/**
 * Public KVKK-compliant registration form (0018): organizer settings and permissions, the privacy-notice proof and the
 * optional consent, capacity, duplicates, notice versions, erasure on request and after the retention period, the
 * ticket page — Route Handlers on a migrated database, e-mail stubbed.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { attendees, eventRegistrations, events } from "@/db/schema";
import { ORG_A, ORG_B, outcome, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown, user: null as string | null }));
vi.mock("@/db", async () => {
  const { withRls } = await import("@/db/rls");
  class UnauthenticatedError extends Error {}
  const claims = () => { if (!h.user) throw new UnauthenticatedError("Not signed in"); return { sub: h.user }; };
  return {
    UnauthenticatedError,
    getVerifiedClaims: async () => claims(),
    getUserDb: async () => { const c = claims(); return <T,>(fn: Parameters<typeof withRls<T>>[2]) => withRls(h.db as never, c, fn); },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});

const formRoute = await import("@/app/api/events/[eventId]/registration-form/route");
const listRoute = await import("@/app/api/events/[eventId]/registrations/route");
const oneRoute = await import("@/app/api/registrations/[registrationId]/route");
const publicRoute = await import("@/app/api/public/registrations/[token]/route");
const ticketRoute = await import("@/app/api/public/tickets/[token]/route");
const { purgeExpiredRegistrations } = await import("@/server/registration/registration-service");

let ctx: Awaited<ReturnType<typeof setupDb>>;
let ev = "", token = "";
let ip = 0;
const as = (u: string | null) => { h.user = u; };
const P = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: r.status === 204 ? null : await r.json() });
const send = (method: string, body?: unknown) => new Request("http://localhost:3000/api", {
  method, headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++ip}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const get = (q: Record<string, string>) => new Request(`http://localhost:3000/api?${new URLSearchParams(q)}`, { headers: { "x-forwarded-for": `203.0.113.${++ip}` } });
const day = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date(Date.now() + n * 86_400_000));
const form = async (user = U.ownerA) => { as(user); return json(await formRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }))); };
const save = async (patch: Record<string, unknown>, user = U.ownerA) => {
  const cur = (await form()).body.form;
  as(user);
  return json(await formRoute.PUT(send("PUT", {
    organizationId: ORG_A, enabled: cur.enabled, ticketType: cur.ticketType, capacity: cur.capacity, opensAt: cur.opensAt, closesAt: cur.closesAt,
    collectPhone: cur.collectPhone, privacyNotice: cur.privacyNotice, marketingConsentText: cur.marketingConsentText, retentionDays: cur.retentionDays, ...patch,
  }), P({ eventId: ev })));
};
const pub = async () => { as(null); return json(await publicRoute.GET(get({}), P({ token }))); };
const register = async (body: Record<string, unknown>) => {
  as(null);
  const v = (await pub()).body.form?.noticeVersion ?? 1;
  return json(await publicRoute.POST(send("POST", { noticeVersion: v, noticeAccepted: true, ...body }), P({ token })));
};

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  ev = (await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Adana Lezzet Festivali", status: "live", startDate: day(1), endDate: day(3),
    aiConfig: { event: { city: "Adana" } }, aiConfigVersion: "blueprint/v1" }).returning({ id: events.id }))[0]!.id;
}, 60_000);
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("organizer settings", () => {
  it("created disabled with a privacy-notice template; owner/admin only; another organization sees nothing", async () => {
    expect((await form(U.staffA)).status).toBe(403);
    expect((await form(U.ownerB)).status).toBe(403);
    const f = (await form()).body.form;
    token = f.token;
    expect(f).toMatchObject({ enabled: false, ticketType: "Genel", noticeVersion: 1, retentionDays: 90, registered: 0, state: "not_enabled" });
    expect(f.privacyNotice).toMatch(/Veri sorumlusu: Org A/);
    expect(f.privacyNotice).toMatch(/KVKK m\. 9/);
    expect(f.privacyNotice).toMatch(/m\. 11/);
    expect(f.marketingConsentText).toMatch(/açık rıza/);
    expect(await pub()).toMatchObject({ status: 404 });
  });

  it("validates the settings; enabling opens the public form", async () => {
    expect((await save({ privacyNotice: "kısa" })).status).toBe(400);
    expect((await save({ retentionDays: 0 })).status).toBe(400);
    expect((await save({ capacity: 0 })).status).toBe(400);
    expect((await save({ enabled: true, capacity: 3, collectPhone: true }, U.staffA)).status).toBe(403);
    const r = await save({ enabled: true, capacity: 3, collectPhone: true });
    expect(r).toMatchObject({ status: 200, body: { form: { enabled: true, capacity: 3, state: "open", noticeVersion: 1 } } });
    const p = (await pub()).body.form;
    expect(p).toMatchObject({ eventTitle: "Adana Lezzet Festivali", organization: "Org A", city: "Adana", collectPhone: true, state: "open", noticeVersion: 1 });
    expect(JSON.stringify(p)).not.toMatch(/token|organizationId|retention/);
  });
});

describe("registering", () => {
  it("requires the notice; stores its proof; the consent is optional and recorded with its exact text; the ticket is e-mailed", async () => {
    expect((await register({ fullName: "Ayşe Yılmaz", email: "ayse@ornek.test", noticeAccepted: false })).status).toBe(400);
    expect((await register({ fullName: "A", email: "ayse@ornek.test" })).status).toBe(400);
    expect((await register({ fullName: "Ayşe Yılmaz", email: "ayse@ornek.test", phone: "abc" })).status).toBe(400);
    vi.stubEnv("BREVO_API_KEY", "xkeysib-test-key-1234567890");
    vi.stubEnv("EMAIL_FROM", "Org A <bilgi@ornek.test>");
    vi.stubEnv("APP_URL", "https://etkinlik.ornek.test");
    const mails: { to: { email: string }[]; htmlContent: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { mails.push(JSON.parse(String(init.body))); return new Response("{}", { status: 201 }); }));
    const r = await register({ fullName: "Ayşe Yılmaz", email: "Ayse@Ornek.test", phone: "0532 111 22 33" });
    expect(r).toMatchObject({ status: 201, body: { ticket: { ticketType: "Genel", emailed: true } } });
    const qr = r.body.ticket.qrToken;
    expect(mails[0]!.to).toEqual([{ email: "ayse@ornek.test" }]);
    expect(mails[0]!.htmlContent).toContain(`https://etkinlik.ornek.test/bilet/${qr}`);
    const [row] = await ctx.db.select().from(eventRegistrations).where(eq(eventRegistrations.email, "ayse@ornek.test"));
    const notice = (await form()).body.form.privacyNotice;
    expect(row).toMatchObject({ fullName: "Ayşe Yılmaz", phone: "0532 111 22 33", noticeVersion: 1, marketingConsent: false, marketingConsentAt: null, marketingConsentText: null });
    expect(row!.noticeHash).toBe(createHash("sha256").update(notice).digest("hex"));
    const [att] = await ctx.db.select().from(attendees).where(eq(attendees.id, row!.attendeeId));
    expect(att).toMatchObject({ ticketType: "Genel", qrUuid: qr, eventId: ev });

    const c = await register({ fullName: "Mehmet Kaya", email: "mehmet@ornek.test", marketingConsent: true });
    expect(c.status).toBe(201);
    const [m] = await ctx.db.select().from(eventRegistrations).where(eq(eventRegistrations.email, "mehmet@ornek.test"));
    expect(m!.marketingConsent).toBe(true);
    expect(m!.marketingConsentText).toMatch(/açık rıza veriyorum/);
    expect(m!.marketingConsentAt).not.toBeNull();
  });

  it("one registration per address; capacity; a changed notice must be read again", async () => {
    expect(await register({ fullName: "Ayşe Yılmaz", email: "AYSE@ornek.test" })).toMatchObject({ status: 409, body: { code: "ALREADY_REGISTERED" } });
    // the person read version 1; the organizer changes the notice meanwhile
    as(null);
    const stale = 1;
    await save({ privacyNotice: `${(await form()).body.form.privacyNotice}\n\nİletişim: kvkk@ornek.test` });
    expect((await form()).body.form.noticeVersion).toBe(2);
    as(null);
    expect(await json(await publicRoute.POST(send("POST", { fullName: "Zeynep Ak", email: "zeynep@ornek.test", noticeVersion: stale, noticeAccepted: true }), P({ token }))))
      .toMatchObject({ status: 409, body: { code: "NOTICE_CHANGED" } });
    expect((await register({ fullName: "Zeynep Ak", email: "zeynep@ornek.test" })).status).toBe(201);
    expect(await register({ fullName: "Can Er", email: "can@ornek.test" })).toMatchObject({ status: 409, body: { code: "REGISTRATION_FULL" } });
    expect((await pub()).body.form.state).toBe("full");
    // closing time in the past
    await save({ capacity: null, closesAt: new Date(Date.now() - 60_000).toISOString(), opensAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(await register({ fullName: "Can Er", email: "can@ornek.test" })).toMatchObject({ status: 409, body: { code: "REGISTRATION_CLOSED" } });
    await save({ closesAt: null, opensAt: null });
  });
});

describe("the people's data", () => {
  it("only owner/admin see it; erasure on request keeps the ticket anonymous; browsers have no direct access", async () => {
    as(U.staffA);
    expect((await listRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
    as(U.ownerA);
    const list = (await json(await listRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body.registrations;
    expect(list.map((r: { email: string }) => r.email)).toEqual(["ayse@ornek.test", "mehmet@ornek.test", "zeynep@ornek.test"]);
    expect(list[2]).toMatchObject({ noticeVersion: 2, isCheckedIn: false, ticketType: "Genel" });
    const ayse = list[0];
    as(U.ownerB);
    expect((await oneRoute.DELETE(get({ organizationId: ORG_B }), P({ registrationId: ayse.id }))).status).toBe(404);
    as(U.ownerA);
    expect((await oneRoute.DELETE(get({ organizationId: ORG_A }), P({ registrationId: ayse.id }))).status).toBe(204);
    expect(await ctx.db.select().from(eventRegistrations).where(eq(eventRegistrations.id, ayse.id))).toHaveLength(0);
    expect((await ctx.db.select().from(attendees).where(eq(attendees.eventId, ev))).length).toBe(3); // tickets stay
    for (const t of ["event_registrations", "event_registration_forms"]) {
      expect(await outcome(ctx.as(U.ownerA, (tx) => tx.execute(`select * from ${t}` as never)))).toMatch(/permission denied/);
    }
  });

  it("the ticket page shows the ticket to whoever holds the link", async () => {
    const [m] = await ctx.db.select().from(eventRegistrations).where(eq(eventRegistrations.email, "mehmet@ornek.test"));
    const [a] = await ctx.db.select().from(attendees).where(eq(attendees.id, m!.attendeeId));
    as(null);
    const t = await json(await ticketRoute.GET(get({}), P({ token: a!.qrUuid })));
    expect(t).toMatchObject({ status: 200, body: { ticket: { eventTitle: "Adana Lezzet Festivali", fullName: "Mehmet Kaya", ticketType: "Genel", cancelled: false, isCheckedIn: false } } });
    expect((await ticketRoute.GET(get({}), P({ token: "00000000-0000-4000-8000-000000000000" }))).status).toBe(404);
    expect((await ticketRoute.GET(get({}), P({ token: "kısa" }))).status).toBe(404);
  });

  it("personal data is deleted automatically after the retention period", async () => {
    expect(await purgeExpiredRegistrations()).toBe(0); // the event has not ended
    await ctx.pg.query("update events set start_date = $2, end_date = $3 where id = $1", [ev, day(-100), day(-91)]);
    expect(await purgeExpiredRegistrations()).toBe(2); // ended 91 days ago, retention 90
    expect(await ctx.db.select().from(eventRegistrations).where(eq(eventRegistrations.eventId, ev))).toHaveLength(0);
    expect((await ctx.db.select().from(attendees).where(eq(attendees.eventId, ev))).length).toBe(3);
    expect((await pub()).body.form.state).toBe("event_over");
  });
});
