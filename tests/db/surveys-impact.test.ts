/**
 * 0007 end to end on PGlite: survey lifecycle, anonymous public responses, staff entry, exclusion,
 * multiplier sets, sourced impact inputs and stored (immutable) impact runs — called as Route Handlers
 * with real Requests. Sign-in is simulated at the src/db seam; RLS, requireOrgPermission, adminDb,
 * constraints and triggers are real.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  attendees, events, impactCalculationRuns, surveyQuestions, surveyResponseSpend, surveyResponses, surveys, users,
} from "@/db/schema";
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

const surveysRoute = await import("@/app/api/events/[eventId]/surveys/route");
const surveyRoute = await import("@/app/api/surveys/[surveyId]/route");
const responsesRoute = await import("@/app/api/surveys/[surveyId]/responses/route");
const responseRoute = await import("@/app/api/survey-responses/[responseId]/route");
const publicSurveyRoute = await import("@/app/api/public/surveys/[token]/route");
const publicResponsesRoute = await import("@/app/api/public/surveys/[token]/responses/route");
const setsRoute = await import("@/app/api/multiplier-sets/route");
const setRoute = await import("@/app/api/multiplier-sets/[setId]/route");
const inputsRoute = await import("@/app/api/events/[eventId]/impact/inputs/route");
const runsRoute = await import("@/app/api/events/[eventId]/impact/runs/route");
const impactRoute = await import("@/app/api/events/[eventId]/impact/route");
const fromIoRoute = await import("@/app/api/multiplier-sets/from-io/route");

let ctx: Awaited<ReturnType<typeof setupDb>>;
const as = (user: string | null) => { h.user = user; };
const send = (method: string, body?: unknown) =>
  new Request("http://test.local/api", { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (q: Record<string, string> = {}) => new Request(`http://test.local/api?${new URLSearchParams(q)}`, { method: "GET" });
const P = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

/** The attendee survey of the question bank (attributable spend + accessibility), stored like apply-proposal does. */
const BANK = [...QUESTION_BANK.attributable_visitor_spend!.questions, ...QUESTION_BANK.accessibility_satisfaction!.questions];
async function makeSurvey(org: string, eventId: string, withQuestions = true) {
  const [s] = await ctx.db.insert(surveys).values({ organizationId: org, eventId, audience: "ATTENDEE", title: "Ziyaretçi anketi" }).returning();
  if (withQuestions) {
    await ctx.db.insert(surveyQuestions).values(BANK.map((q, i) => {
      const { key, type, text, required, options, isSensitive, ...rest } = q;
      return {
        organizationId: org, eventId, surveyId: s!.id, audience: "ATTENDEE" as const, questionKey: key, type, questionText: text,
        isMandatory: required, options: options ?? null, isSensitive: isSensitive ?? false, metadata: JSON.parse(JSON.stringify(rest)), position: i,
      };
    }));
  }
  return s!.id;
}
const makeEvent = async (org: string, title: string, aiEvent: Record<string, unknown> | null = null) =>
  (await ctx.db.insert(events).values({ organizationId: org, title, ...(aiEvent ? { aiConfig: { event: aiEvent }, aiConfigVersion: "blueprint/v1" } : {}) })
    .returning({ id: events.id }))[0]!.id;

const VISITOR = {
  q_home_province: 6, q_is_local: false, q_party_size: 2, q_days_present: 2,
  q_spend_accommodation: 1000, q_spend_food: 400, q_main_reason: "event", q_would_visit_anyway: "no",
};
const LOCAL = { q_home_province: 35, q_is_local: true, q_days_present: 1 };

let ev = "", evB = "", survey = "", token = "", staffResponseId = "";

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  ev = await makeEvent(ORG_A, "İzmir Festivali", { nuts2Code: "TR31", expectedAttendance: 5000 });
  evB = await makeEvent(ORG_B, "B etkinliği");
  survey = await makeSurvey(ORG_A, ev);
}, 60_000);

describe("survey lifecycle", () => {
  it("open: owner/admin only; DRAFT → OPEN creates a link token; again → 409; a survey without questions → 422", async () => {
    as(U.staffA);
    expect((await surveyRoute.POST(send("POST", { organizationId: ORG_A, action: "open" }), P({ surveyId: survey }))).status).toBe(403);
    as(U.ownerB);
    expect((await surveyRoute.POST(send("POST", { organizationId: ORG_A, action: "open" }), P({ surveyId: survey }))).status).toBe(403);
    expect((await surveyRoute.POST(send("POST", { organizationId: ORG_B, action: "open" }), P({ surveyId: survey }))).status).toBe(404);
    as(U.ownerA);
    const r = await json(await surveyRoute.POST(send("POST", { organizationId: ORG_A, action: "open" }), P({ surveyId: survey })));
    expect(r).toMatchObject({ status: 200, body: { survey: { status: "OPEN", publicToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } } });
    token = r.body.survey.publicToken;
    expect((await json(await surveyRoute.POST(send("POST", { organizationId: ORG_A, action: "open" }), P({ surveyId: survey })))).body.code).toBe("INVALID_TRANSITION");
    const empty = await makeSurvey(ORG_A, await makeEvent(ORG_A, "Boş"), false);
    expect((await json(await surveyRoute.POST(send("POST", { organizationId: ORG_A, action: "open" }), P({ surveyId: empty })))).body.code).toBe("NO_QUESTIONS");
  });

  it("the event's survey list shows the link token to owner/admin only", async () => {
    as(U.staffA);
    const staff = (await json(await surveysRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body.surveys;
    expect(staff).toHaveLength(1);
    expect(staff[0]).not.toHaveProperty("publicToken");
    expect(staff[0]).toMatchObject({ status: "OPEN", questions: BANK.length, responses: 0 });
    as(U.ownerA);
    expect((await json(await surveysRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body.surveys[0].publicToken).toBe(token);
    as(U.ownerB);
    expect((await surveysRoute.GET(get({ organizationId: ORG_B }), P({ eventId: ev }))).status).toBe(404);
  });
});

describe("public link (no session)", () => {
  it("shows the questions of an OPEN survey; unknown or malformed links are 404", async () => {
    as(null);
    const r = await json(await publicSurveyRoute.GET(get(), P({ token })));
    expect(r.status).toBe(200);
    expect(r.body.survey.questions.map((q: { key: string }) => q.key)).toEqual(BANK.map((q) => q.key));
    expect(r.body.survey).not.toHaveProperty("organizationId");
    expect((await publicSurveyRoute.GET(get(), P({ token: "x".repeat(43) }))).status).toBe(404);
    expect((await publicSurveyRoute.GET(get(), P({ token: "../../etc" }))).status).toBe(404);
  });

  it("rejects invalid answers with every problem listed, and stores nothing", async () => {
    as(null);
    const bad = await json(await publicResponsesRoute.POST(send("POST", {
      answers: { q_home_province: 99, q_is_local: true, q_party_size: 3, q_nope: 1 },
    }), P({ token })));
    expect(bad.status).toBe(422);
    expect(bad.body.problems).toEqual(expect.arrayContaining([
      "q_nope: not a question of this survey",
      "q_home_province: must be a province plate code 1–81, or 0 for abroad",
      "q_party_size: not asked for the given answers (showIf)",
      "q_days_present: required",
    ]));
    expect(await ctx.db.select().from(surveyResponses)).toHaveLength(0);
  });

  it("a sensitive answer needs the respondent's explicit consent", async () => {
    as(null);
    const r = await json(await publicResponsesRoute.POST(send("POST", { answers: { ...LOCAL, q_access_need: true, q_accessibility: 4 } }), P({ token })));
    expect(r.body.problems).toEqual(["q_access_need: sensitive answer without consent"]);
    const ok = await publicResponsesRoute.POST(send("POST", { answers: { ...LOCAL, q_access_need: true, q_accessibility: 4 }, sensitiveConsent: true }), P({ token }));
    expect(ok.status).toBe(201);
  });

  it("stores an anonymous response with the normalised profile and spend in kuruş", async () => {
    as(null);
    const r = await json(await publicResponsesRoute.POST(send("POST", { answers: { ...VISITOR, q_spend_food: 400.5 } }), P({ token })));
    expect(r).toMatchObject({ status: 201, body: { response: { submittedAt: expect.any(String) } } });
    expect(r.body.response).not.toHaveProperty("id");
    const [row] = await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.partySize, 2));
    expect(row).toMatchObject({
      organizationId: ORG_A, eventId: ev, channel: "PUBLIC_LINK", enteredBy: null, isLocalResident: false, homeProvinceCode: 6,
      partySize: 2, daysPresent: 2, mainReason: "event", wouldVisitAnyway: "no", surveyVersion: 1, isExcluded: false,
    });
    const spend = await ctx.db.select().from(surveyResponseSpend).where(eq(surveyResponseSpend.responseId, row!.id));
    expect(spend.map((s) => [s.category, s.amountKurus]).sort()).toEqual([["ACCOMMODATION", 100_000], ["FOOD_BEVERAGE", 40_050]]);
  });
});

describe("staff entry, reading and exclusion", () => {
  it("staff may type in a response (survey.collect); another tenant may not", async () => {
    as(U.ownerB);
    expect((await responsesRoute.POST(send("POST", { organizationId: ORG_A, answers: VISITOR }), P({ surveyId: survey }))).status).toBe(403);
    expect((await responsesRoute.POST(send("POST", { organizationId: ORG_B, answers: VISITOR }), P({ surveyId: survey }))).status).toBe(404);
    as(U.staffA);
    const r = await json(await responsesRoute.POST(send("POST", { organizationId: ORG_A, answers: VISITOR }), P({ surveyId: survey })));
    expect(r.status).toBe(201);
    staffResponseId = r.body.response.id;
    expect((await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.id, staffResponseId)))[0]).toMatchObject({ channel: "STAFF_ENTRY", enteredBy: U.staffA });
  });

  it("responses are readable by owner/admin only — by permission and by RLS — and never writable from the browser", async () => {
    as(U.staffA);
    expect((await responsesRoute.GET(get({ organizationId: ORG_A }), P({ surveyId: survey }))).status).toBe(403);
    as(U.ownerA);
    const list = (await json(await responsesRoute.GET(get({ organizationId: ORG_A }), P({ surveyId: survey })))).body.responses;
    expect(list).toHaveLength(3);
    expect(list.find((x: { id: string }) => x.id === staffResponseId).spendKurus).toEqual({ ACCOMMODATION: 100_000, FOOD_BEVERAGE: 40_000 });

    expect(await outcome(ctx.as(U.staffA, (tx) => tx.select().from(surveyResponses)))).toBe(0);
    expect(await outcome(ctx.as(U.staffA, (tx) => tx.select().from(surveyResponseSpend)))).toBe(0);
    expect(await outcome(ctx.as(U.ownerB, (tx) => tx.select().from(surveyResponses)))).toBe(0);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.select().from(surveyResponses)))).toBe(3);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.insert(surveyResponses).values({
      organizationId: ORG_A, eventId: ev, surveyId: survey, audience: "ATTENDEE", surveyVersion: 1, channel: "PUBLIC_LINK", answers: {},
    })))).toMatch(/permission denied/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(surveyResponses).set({ isExcluded: true, exclusionReason: "x" })))).toMatch(/permission denied/);
  });

  it("exclusion needs a reason, is reversible, and is scoped to the organization", async () => {
    as(U.ownerA);
    expect((await responseRoute.PATCH(send("PATCH", { organizationId: ORG_A, isExcluded: true }), P({ responseId: staffResponseId }))).status).toBe(400);
    const r = await json(await responseRoute.PATCH(send("PATCH", { organizationId: ORG_A, isExcluded: true, reason: "Test girişi" }), P({ responseId: staffResponseId })));
    expect(r.body.response).toEqual({ id: staffResponseId, isExcluded: true, exclusionReason: "Test girişi" });
    as(U.ownerB);
    expect((await responseRoute.PATCH(send("PATCH", { organizationId: ORG_B, isExcluded: false }), P({ responseId: staffResponseId }))).status).toBe(404);
    as(U.ownerA);
    expect((await json(await surveysRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body.surveys[0].responses).toBe(2);
  });

  it("a closed survey accepts nothing", async () => {
    as(U.ownerA);
    expect((await json(await surveyRoute.POST(send("POST", { organizationId: ORG_A, action: "close" }), P({ surveyId: survey })))).body.survey.status).toBe("CLOSED");
    as(null);
    expect((await json(await publicResponsesRoute.POST(send("POST", { answers: LOCAL }), P({ token })))).body.code).toBe("SURVEY_NOT_OPEN");
    as(U.staffA);
    expect((await responsesRoute.POST(send("POST", { organizationId: ORG_A, answers: LOCAL }), P({ surveyId: survey }))).status).toBe(409);
  });
});

describe("impact: multiplier sets, inputs, runs", () => {
  let setId = "", evImpact = "";
  const coefficients = [
    { spendCategory: "ACCOMMODATION", a64Code: "I55", output: 1.5, valueAdded: 0.6, income: 0.3, employmentPerMTry: 10 },
    { spendCategory: "FOOD_BEVERAGE", a64Code: "I56", output: 1.8, valueAdded: 0.5, income: 0.25, employmentPerMTry: 20 },
  ];
  const setBody = {
    organizationId: ORG_A, name: "TR31 FLQ test seti", source: "Test verisi — gerçek bir TÜİK tablosu değildir", ioBaseYear: 2023, priceYear: 2026,
    nuts2Code: "TR31", method: "FLQ", multiplierType: "TYPE_I", coefficients,
  };

  beforeAll(async () => {
    // A separate event with exactly 200 visitors + 200 locals and 1,000 checked-in tickets.
    evImpact = await makeEvent(ORG_A, "Etki etkinliği", { nuts2Code: "TR31", expectedAttendance: 9999 });
    const s = await makeSurvey(ORG_A, evImpact);
    const base = { organizationId: ORG_A, eventId: evImpact, surveyId: s, audience: "ATTENDEE" as const, surveyVersion: 1, channel: "PUBLIC_LINK" as const };
    const vis = await ctx.db.insert(surveyResponses).values(Array.from({ length: 200 }, () => ({
      ...base, answers: VISITOR, isLocalResident: false, partySize: 2, daysPresent: 2, wouldVisitAnyway: "no", mainReason: "event",
    }))).returning({ id: surveyResponses.id });
    await ctx.db.insert(surveyResponses).values(Array.from({ length: 200 }, () => ({ ...base, answers: LOCAL, isLocalResident: true, daysPresent: 1 })));
    await ctx.db.insert(surveyResponseSpend).values(vis.flatMap((v) => [
      { responseId: v.id, organizationId: ORG_A, category: "ACCOMMODATION" as const, amountKurus: 100_000 },
      { responseId: v.id, organizationId: ORG_A, category: "FOOD_BEVERAGE" as const, amountKurus: 40_000 },
    ]));
    await ctx.db.insert(attendees).values(Array.from({ length: 1000 }, () => ({
      organizationId: ORG_A, eventId: evImpact, ticketType: "genel", isCheckedIn: true, checkedInAt: new Date(),
    })));
  });

  it("multiplier sets: owner/admin record them with a source; members read them; other tenants see none", async () => {
    as(U.staffA);
    expect((await setsRoute.POST(send("POST", setBody))).status).toBe(403);
    as(U.ownerA);
    expect((await setsRoute.POST(send("POST", { ...setBody, nuts2Code: null }))).status).toBe(400); // FLQ without a region
    expect((await setsRoute.POST(send("POST", { ...setBody, source: "kısa" }))).status).toBe(400);
    expect((await setsRoute.POST(send("POST", { ...setBody, coefficients: [coefficients[0], coefficients[0]] }))).status).toBe(400);
    const r = await json(await setsRoute.POST(send("POST", setBody)));
    expect(r.status).toBe(201);
    setId = r.body.multiplierSet.id;
    as(U.staffA);
    const list = (await json(await setsRoute.GET(get({ organizationId: ORG_A })))).body.multiplierSets;
    expect(list).toHaveLength(1);
    expect(list[0].coefficients).toEqual([
      { spendCategory: "ACCOMMODATION", a64Code: "I55", output: 1.5, valueAdded: 0.6, income: 0.3, employmentPerMTry: 10 },
      { spendCategory: "FOOD_BEVERAGE", a64Code: "I56", output: 1.8, valueAdded: 0.5, income: 0.25, employmentPerMTry: 20 },
    ]);
    as(U.ownerB);
    expect((await json(await setsRoute.GET(get({ organizationId: ORG_B })))).body.multiplierSets).toEqual([]);
    expect((await setRoute.PATCH(send("PATCH", { organizationId: ORG_B, isActive: false }), P({ setId }))).status).toBe(404);
  });

  it("inputs: every adjustment needs a source; another tenant's multiplier set cannot be chosen", async () => {
    const body = {
      organizationId: ORG_A, priceYear: 2026, attributionMethod: "RECORDED_DEADWEIGHT", multiplierSetId: setId,
      deadweight: { value: 0.2, source: "Test: kayıtlı deadweight kaynağı" },
      displacement: { value: 0.1, source: "Test: kayıtlı displacement kaynağı" },
      leakage: { value: 0.25, source: "Test: kayıtlı leakage kaynağı" },
    };
    as(U.staffA);
    expect((await inputsRoute.PUT(send("PUT", body), P({ eventId: evImpact }))).status).toBe(403);
    as(U.ownerA);
    expect((await inputsRoute.PUT(send("PUT", { ...body, deadweight: { value: 0.2, source: "" } }), P({ eventId: evImpact }))).status).toBe(400);
    expect((await inputsRoute.PUT(send("PUT", { ...body, deadweight: { value: 1.2, source: "Test: kayıtlı kaynak" } }), P({ eventId: evImpact }))).status).toBe(400);
    expect((await inputsRoute.PUT(send("PUT", { ...body, multiplierSetId: "00000000-0000-4000-8000-000000000000" }), P({ eventId: evImpact }))).status).toBe(404);
    expect((await inputsRoute.PUT(send("PUT", body), P({ eventId: evB }))).status).toBe(404);
    const r = await json(await inputsRoute.PUT(send("PUT", body), P({ eventId: evImpact })));
    expect(r.body.inputs).toMatchObject({ priceYear: 2026, deadweight: { value: 0.2 }, leakage: { value: 0.25 }, multiplierSetId: setId });
    // The database refuses a value without its source even for server code.
    expect(await outcome(ctx.pg.query(`update event_impact_inputs set leakage_source = null where event_id = $1`, [evImpact]))).toMatch(/event_impact_inputs_leakage_sourced/);
  });

  it("readiness shows the live counts and checks, never a figure", async () => {
    as(U.staffA);
    const r = (await json(await impactRoute.GET(get({ organizationId: ORG_A }), P({ eventId: evImpact })))).body.impact;
    expect(r).toMatchObject({
      inputs: { attendance: { basis: "CHECKIN", value: 1000 }, responses: { nonResidentWithSpend: 200, withAttributionAnswers: 200 }, assumptionsRecorded: true },
      assessment: { achievedLevel: "ECONOMIC_IMPACT", status: "SUCCEEDED" },
      figures: null, latestRun: null,
    });
  });

  it("a run stores the figures its level reached, with checks and inputs; members read runs; it can never be changed", async () => {
    as(U.staffA);
    expect((await runsRoute.POST(send("POST", { organizationId: ORG_A }), P({ eventId: evImpact }))).status).toBe(403);
    as(U.ownerA);
    expect((await runsRoute.POST(send("POST", { organizationId: ORG_A }), P({ eventId: evB }))).status).toBe(404);
    const r = await json(await runsRoute.POST(send("POST", { organizationId: ORG_A, level: "ECONOMIC_IMPACT" }), P({ eventId: evImpact })));
    expect(r.status).toBe(201);
    // 1,000 × 0.5 visitors × 2 days × 350 TL = 350,000; × 0.72 = 252,000; local demand 135,000 + 54,000
    expect(r.body.run).toMatchObject({
      requestedLevel: "ECONOMIC_IMPACT", achievedLevel: "ECONOMIC_IMPACT", status: "SUCCEEDED", multiplierSetId: setId,
      attendanceBasis: "CHECKIN", attendanceUsed: 1000, sampleSize: 200,
      figures: { grossDirectSpend: 350_000, attributableSpend: 252_000, totalOutputImpact: 299_700, totalValueAdded: 108_000, totalIncome: 54_000, totalEmploymentFte: 2.43 },
    });
    expect(r.body.run.inputSnapshot).toMatchObject({ assumptions: { priceYear: 2026, leakage: { value: 0.25 } }, multiplierSet: { id: setId, priceYear: 2026 } });

    as(U.staffA);
    const runs = (await json(await runsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: evImpact })))).body.runs;
    expect(runs.map((x: { id: string }) => x.id)).toEqual([r.body.run.id]);
    as(U.ownerB);
    expect((await runsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: evImpact }))).status).toBe(403);
    expect(await outcome(ctx.as(U.ownerB, (tx) => tx.select().from(impactCalculationRuns)))).toBe(0);

    expect(await outcome(ctx.pg.query(`update impact_calculation_runs set total_output_impact = 1 where id = $1`, [r.body.run.id]))).toMatch(/immutable/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.delete(impactCalculationRuns)))).toMatch(/permission denied/);
    // A set used by a run cannot be deleted.
    expect(await outcome(ctx.pg.query(`delete from multiplier_sets where id = $1`, [setId]))).toMatch(/impact_calculation_runs_multiplier_set_same_org_fk/);
  });

  it("the database refuses a figure for a level the run did not reach", async () => {
    const base = `insert into impact_calculation_runs (organization_id, event_id, requested_level, achieved_level, status, engine_version,
      data_sufficiency, input_snapshot, sample_size, attendance_basis, attendance_used`;
    expect(await outcome(ctx.pg.query(`${base}, gross_direct_spend, total_output_impact)
      values ($1, $2, 'economic_impact', 'spend', 'INSUFFICIENT_DATA', 't', '[]', '{}', 0, 'CHECKIN', 10, 1, 2)`, [ORG_A, evImpact])))
      .toMatch(/impact_calculation_runs_economic_only_when_reached/);
    expect(await outcome(ctx.pg.query(`${base}, gross_direct_spend)
      values ($1, $2, 'spend', 'economic_impact', 'SUCCEEDED', 't', '[]', '{}', 0, 'CHECKIN', 10, 1)`, [ORG_A, evImpact])))
      .toMatch(/impact_calculation_runs_achieved_not_above_requested/);
    expect(await outcome(ctx.pg.query(`${base}, gross_direct_spend)
      values ($1, $2, 'spend', 'insufficient_data', 'INSUFFICIENT_DATA', 't', '[]', '{}', 0, null, null, 5)`, [ORG_A, evImpact])))
      .toMatch(/impact_calculation_runs_gross_only_when_reached/);
  });

  it("a TÜİK 2023 FLQ set (price year 2023) drives a 2026 run to level 3, without an employment figure", async () => {
    as(U.ownerA);
    const KEYS = ["A", "B-E", "F", "G-I", "J", "K", "L", "M-N", "O-Q", "R-U"];
    const region = {
      nuts2Code: "TR31", delta: 0.3, deltaSource: "Test değeri — kaynaklı bir tahmin değildir", dataSource: "Test verisi — TÜİK bölgesel hesapları değildir",
      regional: Object.fromEntries(KEYS.map((k) => [k, k === "G-I" ? 19 : 9])), national: Object.fromEntries(KEYS.map((k) => [k, 100])),
    };
    const set = (await json(await fromIoRoute.POST(send("POST", { organizationId: ORG_A, name: "TÜİK TR31", region })))).body.multiplierSet;
    const inputs = {
      organizationId: ORG_A, priceYear: 2026, attributionMethod: "RECORDED_DEADWEIGHT", multiplierSetId: set.id,
      deadweight: { value: 0.2, source: "Test: kayıtlı deadweight kaynağı" },
      displacement: { value: 0.1, source: "Test: kayıtlı displacement kaynağı" },
      leakage: { value: 0.25, source: "Test: kayıtlı leakage kaynağı" },
    };
    expect((await inputsRoute.PUT(send("PUT", inputs), P({ eventId: evImpact }))).status).toBe(200);
    const r = (await json(await runsRoute.POST(send("POST", { organizationId: ORG_A, level: "ECONOMIC_IMPACT" }), P({ eventId: evImpact })))).body.run;
    expect(r).toMatchObject({ achievedLevel: "ECONOMIC_IMPACT", status: "SUCCEEDED", multiplierSetId: set.id });
    expect(r.figures.totalEmploymentFte).toBeNull();
    const coef = (c: string) => set.coefficients.find((x: { spendCategory: string }) => x.spendCategory === c);
    // local demand as before: accommodation 135,000, food 54,000
    expect(r.figures.totalOutputImpact).toBeCloseTo(135_000 * coef("ACCOMMODATION").output + 54_000 * coef("FOOD_BEVERAGE").output, 1);
    expect(r.checks.find((c: { check: string }) => c.check === "price_years_match")).toBeUndefined();
    await inputsRoute.PUT(send("PUT", { ...inputs, multiplierSetId: setId }), P({ eventId: evImpact }));
  });

  it("default attribution is measured from the survey (strict rule); the recorded method needs a deadweight", async () => {
    as(U.ownerA);
    const base = {
      organizationId: ORG_A, priceYear: 2026, multiplierSetId: setId,
      displacement: { value: 0.1, source: "Test: kayıtlı displacement kaynağı" },
      leakage: { value: 0.25, source: "Test: kayıtlı leakage kaynağı" },
    };
    expect((await inputsRoute.PUT(send("PUT", { ...base, attributionMethod: "RECORDED_DEADWEIGHT" }), P({ eventId: evImpact }))).status).toBe(400);
    expect(await outcome(ctx.pg.query(`update event_impact_inputs set attribution_method = 'RECORDED_DEADWEIGHT', deadweight = null, deadweight_source = null
      where event_id = $1`, [evImpact]))).toMatch(/event_impact_inputs_attribution_method/);
    const put = await json(await inputsRoute.PUT(send("PUT", base), P({ eventId: evImpact })));
    expect(put.body.inputs).toMatchObject({ attributionMethod: "SURVEY_STRICT", deadweight: null });
    const r = (await json(await runsRoute.POST(send("POST", { organizationId: ORG_A }), P({ eventId: evImpact })))).body.run;
    // every visitor answered "event" + "would not have come": the whole gross spend is attributable, × (1 − 0.1)
    expect(r).toMatchObject({ achievedLevel: "ECONOMIC_IMPACT", engineVersion: "impact-engine/2.0.0",
      figures: { grossDirectSpend: 350_000, attributableSpend: 315_000 } });
    expect(r.checks.find((c: { check: string }) => c.check === "attribution_from_survey")).toMatchObject({ passed: true });
    expect(r.breakdown.attribution).toMatchObject({ method: "SURVEY_STRICT", respondents: 200, strictSpendShare: 1, sensitivity: { attributableSpend: 315_000 } });
    expect(r.inputSnapshot.assumptions).toMatchObject({ attributionMethod: "SURVEY_STRICT" });
    await inputsRoute.PUT(send("PUT", { ...base, attributionMethod: "RECORDED_DEADWEIGHT",
      deadweight: { value: 0.2, source: "Test: kayıtlı deadweight kaynağı" } }), P({ eventId: evImpact }));
  });

  it("excluded responses and a deactivated set change the next run, not the stored one (199 attribution answers < 200 → level 1 only)", async () => {
    as(U.ownerA);
    await setRoute.PATCH(send("PATCH", { organizationId: ORG_A, isActive: false }), P({ setId }));
    const [one] = await ctx.db.select({ id: surveyResponses.id }).from(surveyResponses)
      .where(and(eq(surveyResponses.eventId, evImpact), eq(surveyResponses.isLocalResident, false))).limit(1);
    await responseRoute.PATCH(send("PATCH", { organizationId: ORG_A, isExcluded: true, reason: "Tekrarlanan yanıt" }), P({ responseId: one!.id }));
    const r = (await json(await runsRoute.POST(send("POST", { organizationId: ORG_A }), P({ eventId: evImpact })))).body.run;
    expect(r).toMatchObject({ achievedLevel: "SPEND", status: "INSUFFICIENT_DATA", sampleSize: 199, multiplierSetId: null });
    // visitor share is now 199 / 399: 1,000 × 199/399 × 2 days × 350 TL
    expect(r.figures).toMatchObject({ grossDirectSpend: Math.round(((1000 * 199) / 399) * 700 * 100) / 100, attributableSpend: null, totalOutputImpact: null });
    expect(r.checks.find((c: { check: string }) => c.check === "min_attribution_responses")).toMatchObject({ passed: false, required: 200, actual: 199 });
    expect(r.checks.find((c: { check: string }) => c.check === "multiplier_set_active")).toMatchObject({ passed: false });
    const runs = (await json(await runsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: evImpact })))).body.runs;
    expect(runs).toHaveLength(4);
    expect(runs[3].figures.totalOutputImpact).toBe(299_700);
  });

  it("no data: a run records INSUFFICIENT_DATA with no figure", async () => {
    as(U.ownerA);
    const empty = await makeEvent(ORG_A, "Verisiz");
    const r = (await json(await runsRoute.POST(send("POST", { organizationId: ORG_A, level: "SPEND" }), P({ eventId: empty })))).body.run;
    expect(r).toMatchObject({ achievedLevel: null, status: "INSUFFICIENT_DATA", figures: null, sampleSize: 0 });
    expect((await ctx.db.select().from(impactCalculationRuns).where(eq(impactCalculationRuns.id, r.id)))[0]!.achievedLevel).toBe("insufficient_data");
  });
});

describe("users stay erasable", () => {
  it("deleting the staff member who typed a response keeps the response and its organization", async () => {
    await ctx.pg.query("delete from auth.users where id = $1", [U.staffA]);
    const [r] = await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.id, staffResponseId));
    expect(r).toMatchObject({ enteredBy: null, organizationId: ORG_A });
    expect(await ctx.db.select().from(users).where(eq(users.id, U.staffA))).toHaveLength(0);
  });
});
