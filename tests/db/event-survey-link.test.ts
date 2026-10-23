/**
 * One survey link (one QR code) per event (0015, 0016), like section branching in a form builder: the first question is
 * the respondent's role; each option opens one or more audiences' surveys (by default "Ziyaretçi" → visitor + residents);
 * a question shared by those surveys is asked once and stored on each; every survey keeps its own response.
 * Route Handlers on a migrated database; sign-in simulated at the src/db seam.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eventSurveyLinks, events, surveyQuestions, surveyResponseSpend, surveyResponses, surveys } from "@/db/schema";
import { QUESTION_BANK } from "@/lib/metrics/question-bank";
import { ORG_A, ORG_B, outcome, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown, user: null as string | null }));
vi.mock("@/db", async () => {
  const { withRls } = await import("@/db/rls");
  class UnauthenticatedError extends Error {}
  const claims = () => {
    if (!h.user) throw new UnauthenticatedError("Not signed in");
    return { sub: h.user };
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

const linkRoute = await import("@/app/api/events/[eventId]/survey-link/route");
const surveyRoute = await import("@/app/api/surveys/[surveyId]/route");
const publicRoute = await import("@/app/api/public/event-surveys/[token]/route");
const publicResponsesRoute = await import("@/app/api/public/event-surveys/[token]/responses/route");

let ctx: Awaited<ReturnType<typeof setupDb>>;
const as = (user: string | null) => { h.user = user; };
const send = (method: string, body?: unknown) =>
  new Request("http://test.local/api", { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (q: Record<string, string> = {}) => new Request(`http://test.local/api?${new URLSearchParams(q)}`);
const P = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

const BANK = [...QUESTION_BANK.attributable_visitor_spend!.questions];
type Q = { key: string; type: string; text: string; required: boolean; options?: { value: string; label: string }[]; isSensitive?: boolean };
async function makeSurvey(eventId: string, audience: "ATTENDEE" | "EXHIBITOR" | "SPONSOR" | "RESIDENT", title: string, qs: readonly Q[]) {
  const [s] = await ctx.db.insert(surveys).values({ organizationId: ORG_A, eventId, audience, title }).returning();
  await ctx.db.insert(surveyQuestions).values(qs.map((q, i) => {
    const { key, type, text, required, options, isSensitive, ...rest } = q;
    return {
      organizationId: ORG_A, eventId, surveyId: s!.id, audience, questionKey: key, type: type as never, questionText: text,
      isMandatory: required, options: options ?? null, isSensitive: isSensitive ?? false, metadata: JSON.parse(JSON.stringify(rest)), position: i,
    };
  }));
  return s!.id;
}
const EXHIBITOR_QS: Q[] = [
  { key: "q_ex_satisfaction", type: "LIKERT_5", text: "Etkinlikten ne kadar memnun kaldınız?", required: true },
  { key: "q_ex_return", type: "YES_NO", text: "Bir sonraki etkinlikte yine stant açar mısınız?", required: false },
];
const BANK_IS_LOCAL = BANK.find((q) => q.key === "q_is_local")! as unknown as Q;
const RESIDENT_QS: Q[] = [
  BANK_IS_LOCAL, // shared with the visitor survey: asked once on the combined form
  { key: "q_res_noise", type: "LIKERT_5", text: "Etkinlik çevrenizde ne kadar rahatsızlık yarattı?", required: true },
];
const VISITOR = { q_home_province: 6, q_is_local: false, q_party_size: 2, q_days_present: 2, q_spend_accommodation: 1000, q_spend_food: 400, q_main_reason: "event", q_would_visit_anyway: "no" };

let ev = "", attendeeSurvey = "", exhibitorSurvey = "", sponsorSurvey = "", residentSurvey = "", token = "";
const open = async (id: string, action: "open" | "close" = "open") => {
  as(U.ownerA);
  return json(await surveyRoute.POST(send("POST", { organizationId: ORG_A, action }), P({ surveyId: id })));
};
const link = async (user = U.ownerA) => { as(user); return json(await linkRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }))); };
const publicSurvey = async (t = token) => { as(null); return json(await publicRoute.GET(new Request("http://test.local/api", { headers: { "x-forwarded-for": "198.51.100.7" } }), P({ token: t }))); };
const answer = async (body: unknown, t = token) => {
  as(null);
  return json(await publicResponsesRoute.POST(new Request("http://test.local/api", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.8" }, body: JSON.stringify(body),
  }), P({ token: t })));
};

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  ev = (await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Kordon Festivali", aiConfig: { event: { nuts2Code: "TR31" } }, aiConfigVersion: "blueprint/v1" })
    .returning({ id: events.id }))[0]!.id;
  attendeeSurvey = await makeSurvey(ev, "ATTENDEE", "Ziyaretçi anketi", BANK as unknown as Q[]);
  exhibitorSurvey = await makeSurvey(ev, "EXHIBITOR", "Stant sahibi anketi", EXHIBITOR_QS);
  sponsorSurvey = await makeSurvey(ev, "SPONSOR", "Sponsor anketi", EXHIBITOR_QS.map((q) => ({ ...q, key: q.key.replace("ex", "sp") })));
  residentSurvey = await makeSurvey(ev, "RESIDENT", "Kent sakini anketi", RESIDENT_QS);
}, 60_000);

const put = async (body: Record<string, unknown>, user = U.ownerA) => {
  as(user);
  return json(await linkRoute.PUT(send("PUT", { organizationId: ORG_A, ...body }), P({ eventId: ev })));
};

describe("one QR code for all of the event's surveys", () => {
  it("the link exists before any survey opens (the QR code can be printed); default options; managers only", async () => {
    expect((await link(U.staffA)).status).toBe(403);
    expect((await link(U.ownerB)).status).toBe(403);
    const r = await link();
    expect(r.status).toBe(200);
    token = r.body.link.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.link).toMatchObject({ roleQuestion: "Etkinliğe hangi rolle katıldınız?", customized: false });
    // visitor → visitor + residents survey; residents who did not attend keep their own option
    expect(r.body.link.routes.map((x: { key: string; audiences: string[] }) => [x.key, x.audiences])).toEqual([
      ["attendee", ["ATTENDEE", "RESIDENT"]], ["exhibitor", ["EXHIBITOR"]], ["sponsor", ["SPONSOR"]], ["resident", ["RESIDENT"]],
    ]);
    expect(r.body.link.surveys.map((x: { audience: string; status: string; accepting: boolean }) => [x.audience, x.status, x.accepting]))
      .toEqual([["ATTENDEE", "DRAFT", false], ["EXHIBITOR", "DRAFT", false], ["SPONSOR", "DRAFT", false], ["RESIDENT", "DRAFT", false]]);
    expect((await link()).body.link.token).toBe(token); // one link per event, it does not change
    expect(await publicSurvey()).toMatchObject({ status: 409, body: { code: "SURVEY_NOT_OPEN" } });
  });

  it("'open all' opens every draft; the first question then offers every option", async () => {
    as(U.staffA);
    expect((await linkRoute.POST(send("POST", { organizationId: ORG_A, action: "open_all" }), P({ eventId: ev }))).status).toBe(403);
    await open(sponsorSurvey); // already open: left as is
    as(U.ownerA);
    const r = await json(await linkRoute.POST(send("POST", { organizationId: ORG_A, action: "open_all" }), P({ eventId: ev })));
    expect(r.status).toBe(200);
    expect(r.body.opened).toEqual(["ATTENDEE", "EXHIBITOR", "RESIDENT"]);
    expect(r.body.link.surveys.every((x: { accepting: boolean }) => x.accepting)).toBe(true);

    const p = await publicSurvey();
    expect(p.status).toBe(200);
    expect(p.body.survey.roleQuestion.options.map((o: { value: string; label: string }) => [o.value, o.label])).toEqual([
      ["attendee", "Ziyaretçi / katılımcı"], ["exhibitor", "Stant sahibi / katılımcı firma"], ["sponsor", "Sponsor"],
      ["resident", "Bölge sakiniyim (etkinliğe katılmadım)"],
    ]);
    expect(p.body.survey.routes.find((x: { key: string }) => x.key === "attendee").audiences).toEqual(["ATTENDEE", "RESIDENT"]);
    expect(JSON.stringify(p.body)).not.toMatch(/organization|publicToken|nuts2/);
  });

  it("a visitor answers the visitor and resident questions once; each survey stores its own response, the shared answer in both", async () => {
    const vis = await answer({ role: "attendee", answers: { ...VISITOR, q_res_noise: 2 } });
    expect(vis.status).toBe(201);
    const rows = await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.eventId, ev));
    const att = rows.find((r) => r.surveyId === attendeeSurvey)!;
    const res = rows.find((r) => r.surveyId === residentSurvey)!;
    expect(att).toMatchObject({ audience: "ATTENDEE", channel: "PUBLIC_LINK", homeProvinceCode: 6, isLocalResident: false, partySize: 2 });
    expect(res).toMatchObject({ audience: "RESIDENT", channel: "PUBLIC_LINK", isLocalResident: false });
    expect(Object.keys(res.answers).sort()).toEqual(["q_is_local", "q_res_noise"]);
    expect(att.answers).not.toHaveProperty("q_res_noise");
    expect(await ctx.db.select().from(surveyResponseSpend).where(eq(surveyResponseSpend.responseId, att.id))).toHaveLength(2);
    // a resident who did not attend: only the resident survey
    expect((await answer({ role: "resident", answers: { q_is_local: true, q_res_noise: 4 } })).status).toBe(201);
    expect((await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, residentSurvey))).length).toBe(2);
    expect((await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, attendeeSurvey))).length).toBe(1);
  });

  it("all or nothing: a missing required answer of any opened survey stores nothing; unknown options and links are refused", async () => {
    const before = (await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.eventId, ev))).length;
    const r = await answer({ role: "attendee", answers: VISITOR }); // q_res_noise (required, resident survey) missing
    expect(r).toMatchObject({ status: 422, body: { code: "INVALID_ANSWERS" } });
    expect((await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.eventId, ev))).length).toBe(before);
    expect(await answer({ role: "ALIEN", answers: { q_ex_satisfaction: 5 } })).toMatchObject({ status: 422, body: { code: "INVALID_ANSWERS" } });
    expect((await answer({ role: "exhibitor", answers: { q_ex_return: true } })).status).toBe(422);
    expect((await answer({ role: "exhibitor", answers: { q_ex_satisfaction: 4 } }, "x".repeat(43))).status).toBe(404);
    expect((await publicSurvey("kısa")).status).toBe(404);
  });

  it("the organizer edits the first question and its options; options may only open this event's surveys", async () => {
    const routes = [
      { key: "ziyaretci", label: "Festivale ziyaretçi olarak geldim", audiences: ["ATTENDEE"] },
      { key: "esnaf_firma", label: "Stant açtım / sponsorum", audiences: ["EXHIBITOR", "SPONSOR"] },
    ];
    expect((await put({ roleQuestion: "Festivalde göreviniz neydi?", routes }, U.staffA)).status).toBe(403);
    expect(await put({ roleQuestion: "Festivalde göreviniz neydi?", routes: [{ key: "x", label: "Belediye", audiences: ["PUBLIC_AUTHORITY"] }] }))
      .toMatchObject({ status: 422, body: { code: "SURVEY_LINK_INVALID" } });
    expect((await put({ roleQuestion: "Festivalde göreviniz neydi?", routes: [{ key: "x", label: " ", audiences: ["ATTENDEE"] }] })).status).toBe(400);
    expect((await put({ roleQuestion: "Festivalde göreviniz neydi?", routes: [{ key: "x", label: "A", audiences: [] }] })).status).toBe(400);
    const r = await put({ roleQuestion: "Festivalde göreviniz neydi?", routes });
    expect(r).toMatchObject({ status: 200, body: { link: { roleQuestion: "Festivalde göreviniz neydi?", customized: true } } });

    const p = (await publicSurvey()).body.survey;
    expect(p.roleQuestion.text).toBe("Festivalde göreviniz neydi?");
    expect(p.roleQuestion.options.map((o: { value: string }) => o.value)).toEqual(["ziyaretci", "esnaf_firma"]);
    // one option, two surveys: each gets its own answers
    expect((await answer({ role: "esnaf_firma", answers: { q_ex_satisfaction: 5, q_sp_satisfaction: 3 } })).status).toBe(201);
    const counts = async (id: string) => (await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, id))).length;
    expect([await counts(exhibitorSurvey), await counts(sponsorSurvey)]).toEqual([1, 1]);
    // back to the defaults
    expect((await put({ roleQuestion: null, routes: null })).body.link).toMatchObject({ customized: false, roleQuestion: "Etkinliğe hangi rolle katıldınız?" });
  });

  it("closing a survey removes it from its options; with every survey closed the link is not accepting answers", async () => {
    await open(residentSurvey, "close");
    const p = (await publicSurvey()).body.survey;
    expect(p.routes.find((x: { key: string }) => x.key === "attendee").audiences).toEqual(["ATTENDEE"]);
    expect(p.roleQuestion.options.map((o: { value: string }) => o.value)).not.toContain("resident");
    expect(await answer({ role: "resident", answers: { q_res_noise: 3 } })).toMatchObject({ status: 409, body: { code: "SURVEY_NOT_OPEN" } });
    for (const id of [attendeeSurvey, exhibitorSurvey, sponsorSurvey]) await open(id, "close");
    expect(await publicSurvey()).toMatchObject({ status: 409, body: { code: "SURVEY_NOT_OPEN" } });
    expect((await link()).body.link.token).toBe(token);
  });

  it("the link table is written by the server only; another organization cannot read the link", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.select().from(eventSurveyLinks)))).toMatch(/permission denied/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.insert(eventSurveyLinks).values({ eventId: ev, organizationId: ORG_A, token: "y".repeat(43) })))).toMatch(/permission denied/);
    const [row] = await ctx.db.select().from(eventSurveyLinks).where(and(eq(eventSurveyLinks.eventId, ev), eq(eventSurveyLinks.organizationId, ORG_A)));
    expect(row!.token).toBe(token);
    as(U.ownerB);
    expect((await linkRoute.GET(get({ organizationId: ORG_B }), P({ eventId: ev }))).status).toBe(404);
  });
});
