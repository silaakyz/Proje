/**
 * Drizzle apply service (port step 5): src/server/planning/apply-proposal-drizzle.ts against real
 * PostgreSQL (PGlite) migrated with 0000–0005. `@/db` is mocked so `adminDb` is the PGlite database.
 *
 * PGlite has a single connection: concurrent applies are serialised by the driver, so the double-apply
 * test proves the claim-first logic, not Postgres row-lock behaviour under true parallelism.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiGenerations, eventKpis, events, proposals, surveyQuestions, surveys, tasks, users } from "@/db/schema";
import { ORG_A, ORG_B, outcome, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => {
  class UnauthenticatedError extends Error {}
  return {
    UnauthenticatedError,
    getUserDb: async () => { throw new UnauthenticatedError("not used"); },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});

const mod = await import("@/server/planning/apply-proposal-drizzle");
const errors = await import("@/server/planning/proposal-error");
const ops = await import("@/lib/ai/blueprint/operations");
const { normalizeTasks } = await import("@/lib/ai/blueprint/sections/tasks");
const { blueprintCoreSchema, normalizeBlueprintCore } = await import("@/lib/ai/blueprint/core");
const { buildCoreSystemPrompt } = await import("@/lib/ai/blueprint/prompts");
const { METRIC_LIBRARY } = await import("@/lib/metrics/library");
const { startGeneration, finishGeneration } = await import("@/server/logistics/ai-generations-drizzle");

type Core = import("@/lib/ai/blueprint/core").BlueprintCore;
type Draft = { kind: string; title: string; rationale: string | null; operations: unknown[] };

const TODAY = "2026-10-16";
const ADMIN_A = "a0000000-0000-4000-8000-000000000003";
const fp = (s: string) => createHash("sha256").update(s).digest("hex");
let ctx: Awaited<ReturnType<typeof setupDb>>;
let core: Core;
let eventId = "";
let eventB = "";

const propose = async (org: string, evId: string | null, p: Draft, extra: Partial<typeof proposals.$inferInsert> = {}) => {
  const [row] = await ctx.db.insert(proposals).values({
    organizationId: org, eventId: evId, requestedBy: org === ORG_A ? U.ownerA : U.ownerB, kind: p.kind, title: p.title, rationale: p.rationale,
    payload: { operations: p.operations }, aiFingerprint: fp(JSON.stringify(p.operations) + Math.random()), schemaVersion: "blueprint/v1",
    expiresAt: new Date(Date.now() + 14 * 86_400_000), ...extra,
  }).returning();
  return row!;
};
const proposalRow = async (id: string) => (await ctx.db.select().from(proposals).where(eq(proposals.id, id)))[0]!;
const succeededGeneration = async (org: string, kind: string) => {
  const scope = { organizationId: org, userId: org === ORG_A ? U.ownerA : U.ownerB };
  const id = await startGeneration(scope, { kind, prompt: "p", schemaVersion: "blueprint/v1", provider: "anthropic", model: "m", temperature: 0.2 });
  await finishGeneration(scope, id, { status: "SUCCEEDED", output: { ok: true }, latencyMs: 1 });
  return id;
};
const taskDraft = (titles: string[]) => ({
  assumptions: [],
  tasks: titles.map((title, i) => ({
    key: `task_${["alpha", "beta", "gamma"][i]}`, title, description: null, workstream: "venue", board: "PLANNING" as const,
    phase: "PLAN" as const, priority: "HIGH" as const, dueOffsetDays: -30 - i, assigneeRole: null,
    dependsOnKeys: i === 1 ? ["task_alpha"] : [], stakeholderKind: null,
  })),
});
const kpi = (metricKey: string, extra: Partial<{ target: number | null; rationale: string; objectiveIndex: number | null }> = {}) =>
  ({ metricKey, objectiveIndex: null, target: null, targetBasis: null, rationale: "r", ...extra });
const survey = (over: Record<string, unknown> = {}) => ({
  key: "survey_attendee", audience: "ATTENDEE" as const, title: "Katılımcı anketi", intro: "Bu anket yaklaşık 3 dakika sürer.", targetResponses: 50,
  questions: [
    { key: "q_nps", type: "NPS_0_10" as const, text: "Tavsiye eder misiniz?", required: true, measures: ["nps"], origin: "BANK" as const },
    { key: "x_reason", type: "SINGLE_CHOICE" as const, text: "Neden geldiniz?", required: false, measures: [], origin: "AI" as const,
      options: [{ value: "music", label: "Müzik" }, { value: "food", label: "Yemek" }] },
  ],
  ...over,
});

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  await ctx.pg.query("insert into auth.users (id, email) values ($1, 'adminA@example.com')", [ADMIN_A]);
  await ctx.db.insert(users).values({ id: ADMIN_A, organizationId: ORG_A, email: "adminA@example.com", role: "admin" });
  [{ id: eventB }] = await ctx.db.insert(events).values({ organizationId: ORG_B, title: "B etkinliği", startDate: "2027-05-01" }).returning({ id: events.id }) as [{ id: string }];

  const sys = buildCoreSystemPrompt({ today: TODAY, orgName: "X", organizationType: "MUNICIPALITY" });
  const example = JSON.parse(sys.split("<response>")[1]!.split("</response>")[0]!);
  example.event.startDate = "2027-04-22";
  const n = normalizeBlueprintCore(example, { today: TODAY, organizationType: "MUNICIPALITY" });
  if (!n.ok) throw new Error("core fixture invalid");
  core = n.core;
}, 60_000);

describe("core proposal: exactly-once apply, audit, ai_config", () => {
  let coreProposalId = "";
  let coreGen = "";
  it("double apply creates one event; the second call is refused with NOT_PENDING", async () => {
    coreGen = await succeededGeneration(ORG_A, "blueprint.core");
    const p = await propose(ORG_A, null, ops.coreProposal(core), { generationId: coreGen });
    coreProposalId = p.id;
    const before = (await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length;
    const results = await Promise.allSettled([
      mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA }),
      mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: ADMIN_A }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "NOT_PENDING" });
    expect((await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length).toBe(before + 1);
    eventId = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ eventId: string }>).value.eventId;
  });

  it("records APPROVED (reported as APPLIED), decider, summary; the generation becomes APPLIED and linked", async () => {
    const p = await proposalRow(coreProposalId);
    expect(p).toMatchObject({ status: "APPROVED", eventId, errorMessage: null, appliedOps: null });
    expect([U.ownerA, ADMIN_A]).toContain(p.decidedBy);
    expect(p.decidedAt).toBeInstanceOf(Date);
    expect(p.appliedSummary).toMatchObject({ eventId, applied: 1, created: { event: 1 } });
    expect(errors.toApiProposalStatus(p.status)).toBe("APPLIED");
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA }))
      .rejects.toMatchObject({ code: "NOT_PENDING", message: "Proposal is APPLIED" });
    expect((await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, coreGen)))[0]).toMatchObject({ status: "APPLIED", eventId });
  });

  it("the event keeps the validated core verbatim in ai_config: days, stakeholders and stated budget are not lost", async () => {
    const [ev] = await ctx.db.select().from(events).where(eq(events.id, eventId));
    expect(ev).toMatchObject({ organizationId: ORG_A, title: core.event.title, status: "draft", startDate: "2027-04-22",
      endDate: core.event.endDate, aiConfigVersion: "blueprint/v1" });
    expect(ev!.aiConfig).toEqual(JSON.parse(JSON.stringify(core)));
    expect(blueprintCoreSchema.parse(ev!.aiConfig)).toEqual(core); // what loadApprovedCore will read back
    const cfg = ev!.aiConfig as unknown as Core;
    expect(cfg.stakeholders).toEqual(core.stakeholders);
    expect(cfg.stakeholders.length).toBeGreaterThan(0);
    expect(cfg.budgetTotalMinor).toBe(core.budgetTotalMinor);
    expect(cfg.event).toMatchObject({ startDate: "2027-04-22", durationDays: core.event.durationDays,
      dailyStartTime: core.event.dailyStartTime, dailyEndTime: core.event.dailyEndTime });
  });

  it("a core proposal whose event already exists is refused (CONFLICT) and rolled back", async () => {
    const p = await propose(ORG_A, eventId, ops.coreProposal(core));
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await proposalRow(p.id)).toMatchObject({ status: "PENDING", decidedAt: null, errorMessage: expect.stringMatching(/already exists/) });
  });

  it("a stated total budget survives in ai_config even when it is the only budget information", async () => {
    const withBudget = { ...core, budgetTotalMinor: 125_000_000 };
    const p = await propose(ORG_A, null, ops.coreProposal(withBudget));
    const r = await mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA });
    const [ev] = await ctx.db.select().from(events).where(eq(events.id, r.eventId));
    expect((ev!.aiConfig as unknown as Core).budgetTotalMinor).toBe(125_000_000);
  });
});

describe("rollback, retry and regeneration", () => {
  it("a failed apply rolls back everything (tasks, claim, generation), stays PENDING with the error, and can be retried", async () => {
    const gen = await succeededGeneration(ORG_A, "blueprint.kpis");
    const proposal = ops.kpisProposal([kpi("no_such_metric")], []);
    proposal.operations.unshift(...normalizeTasks(taskDraft(["Mekân sözleşmesi"]), core).tasks.map((data) => ({ op: "upsert" as const, entity: "task" as const, data })));
    const p = await propose(ORG_A, eventId, proposal, { generationId: gen });

    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "INVALID" });
    expect(await proposalRow(p.id)).toMatchObject({ status: "PENDING", decidedBy: null, decidedAt: null, errorMessage: expect.stringMatching(/no_such_metric/) });
    expect(await ctx.db.select().from(tasks).where(and(eq(tasks.eventId, eventId), eq(tasks.blueprintKey, "task_alpha")))).toEqual([]);
    expect((await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, gen)))[0]!.status).toBe("SUCCEEDED");

    // Retry with the failing operation unticked.
    const ok = await mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA, opIndexes: [0] });
    expect(ok.created).toEqual({ task: 1 });
    expect(await proposalRow(p.id)).toMatchObject({ status: "APPROVED", errorMessage: null, appliedOps: [0] });
    expect((await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, gen)))[0]).toMatchObject({ status: "APPLIED", eventId }); // partial selection: as Prisma
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "NOT_PENDING" });
    expect((await ctx.db.select().from(tasks).where(and(eq(tasks.eventId, eventId), eq(tasks.blueprintKey, "task_alpha")))).length).toBe(1);
  });

  it("regenerating preserves DONE and person-edited tasks, updates untouched AI tasks, resolves dependencies and due dates", async () => {
    const first = normalizeTasks(taskDraft(["Mekân sözleşmesi", "Sahne teklifi", "Güvenlik planı"]), core).tasks;
    const r1 = await mod.applyProposal({ proposalId: (await propose(ORG_A, eventId, ops.tasksProposal(first, []))).id, organizationId: ORG_A, actorId: U.ownerA });
    expect(r1).toMatchObject({ created: { task: 2 }, updated: { task: 1 } }); // task_alpha (previous test) is untouched AI → updated
    const byKey = async () => Object.fromEntries((await ctx.db.select().from(tasks)
      .where(and(eq(tasks.eventId, eventId), inArray(tasks.blueprintKey, ["task_alpha", "task_beta", "task_gamma"])))).map((t) => [t.blueprintKey, t]));
    let rows = await byKey();
    expect(rows.task_beta!.dependsOn).toEqual([rows.task_alpha!.id]);
    expect(rows.task_gamma).toMatchObject({ dueDate: "2027-03-21", dueOffsetDays: -32, isAiGenerated: true, organizationId: ORG_A });

    await ctx.db.update(tasks).set({ status: "DONE" }).where(eq(tasks.id, rows.task_alpha!.id));
    await ctx.db.update(tasks).set({ title: "Sahne teklifi (3 firma)" }).where(eq(tasks.id, rows.task_beta!.id));
    const second = normalizeTasks(taskDraft(["Mekân sözleşmesini imzala", "Sahne tekliflerini topla", "Güvenlik planını onaylat"]), core).tasks;
    const p2 = await propose(ORG_A, eventId, ops.tasksProposal(second, []));
    const r = await mod.applyProposal({ proposalId: p2.id, organizationId: ORG_A, actorId: U.ownerA });
    // Exact report: the DONE and the person-edited task are counted as preserved, nothing else.
    expect(r).toEqual({ eventId, applied: 3, created: {}, updated: { task: 1 }, preserved: { task: 2 } });
    expect((await proposalRow(p2.id)).appliedSummary).toEqual(r);
    rows = await byKey();
    expect(rows.task_alpha).toMatchObject({ title: "Mekân sözleşmesi", status: "DONE" });
    expect(rows.task_beta!.title).toBe("Sahne teklifi (3 firma)");
    expect(rows.task_gamma).toMatchObject({ title: "Güvenlik planını onaylat", proposalId: p2.id });
  });
});

describe("KPIs", () => {
  const firstWith = (src: string) => METRIC_LIBRARY.find((m) => m.dataSources[0] === src)!;
  it("data_source follows the agreed rule, also for metrics with several sources", async () => {
    // key → expected (SURVEY → survey, REGISTRATION/CHECKIN → ticket_sales, others → system; survey > ticket_sales > system)
    const expected = {
      nps: "survey",                         // [SURVEY]
      registrations_confirmed: "ticket_sales", // [REGISTRATION]
      b2b_meetings_completed: "system",      // [MANUAL_ENTRY]
      unique_visitors_estimated: "survey",   // [MANUAL_ENTRY, EXTERNAL_API, SURVEY] — "first source" would give system
      incidents_per_10k: "ticket_sales",     // [MANUAL_ENTRY, CHECKIN] — "first source" would give system
      cost_per_attendee: "ticket_sales",     // [FINANCE, CHECKIN] — "first source" would give system
    } as const;
    const p = await propose(ORG_A, eventId, ops.kpisProposal(Object.keys(expected).map((k) => kpi(k)), []));
    await mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA });
    const got = Object.fromEntries((await ctx.db.select().from(eventKpis)
      .where(and(eq(eventKpis.eventId, eventId), inArray(eventKpis.metricName, Object.keys(expected))))).map((k) => [k.metricName, k.dataSource]));
    expect(got).toEqual(expected);
  });

  it("the rule maps every library metric; no sources or an unknown source is INVALID (no silent default)", () => {
    const byRule = (src: readonly string[]) =>
      src.includes("SURVEY") ? "survey" : src.some((x) => x === "REGISTRATION" || x === "CHECKIN") ? "ticket_sales" : "system";
    for (const m of METRIC_LIBRARY) expect(mod.kpiDataSourceFor(m.key, m.dataSources)).toBe(byRule(m.dataSources));
    expect(() => mod.kpiDataSourceFor("m", [])).toThrow(expect.objectContaining({ code: "INVALID", message: "No data source mapping for metric m" }));
    expect(() => mod.kpiDataSourceFor("m", ["SURVEY", "FAX"])).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(() => mod.kpiDataSourceFor("m", ["toString"])).toThrow(expect.objectContaining({ code: "INVALID" }));
  });

  it("an untouched AI KPI with a numeric target is updated on regeneration (numeric normalised before hashing)", async () => {
    const key = firstWith("SURVEY").key;
    await mod.applyProposal({ proposalId: (await propose(ORG_A, eventId, ops.kpisProposal([kpi(key, { target: 40, rationale: "ilk" })], []))).id, organizationId: ORG_A, actorId: U.ownerA });
    const [k1] = await ctx.db.select().from(eventKpis).where(and(eq(eventKpis.eventId, eventId), eq(eventKpis.metricName, key)));
    expect(k1).toMatchObject({ targetValue: "40.0000", status: "PROPOSED", metricVersion: 1, rationale: "ilk" });
    const r = await mod.applyProposal({ proposalId: (await propose(ORG_A, eventId, ops.kpisProposal([kpi(key, { target: 45, rationale: "ikinci" })], []))).id, organizationId: ORG_A, actorId: U.ownerA });
    expect(r.updated).toEqual({ kpi: 1 });
    const [k2] = await ctx.db.select().from(eventKpis).where(eq(eventKpis.id, k1!.id));
    expect(k2).toMatchObject({ targetValue: "45.0000", rationale: "ikinci" });
  });

  it("an activated KPI is never rewritten", async () => {
    const key = firstWith("SURVEY").key;
    await ctx.db.update(eventKpis).set({ status: "ACTIVE" }).where(and(eq(eventKpis.eventId, eventId), eq(eventKpis.metricName, key)));
    const r = await mod.applyProposal({ proposalId: (await propose(ORG_A, eventId, ops.kpisProposal([kpi(key, { target: 99 })], []))).id, organizationId: ORG_A, actorId: U.ownerA });
    expect(r.preserved).toEqual({ kpi: 1 });
    expect((await ctx.db.select().from(eventKpis).where(and(eq(eventKpis.eventId, eventId), eq(eventKpis.metricName, key))))[0]!.targetValue).toBe("45.0000");
  });

  it("an unknown metric is INVALID, nothing is written", async () => {
    const p = await propose(ORG_A, eventId, ops.kpisProposal([kpi("made_up_metric")], []));
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "INVALID" });
    expect(await ctx.db.select().from(eventKpis).where(eq(eventKpis.metricName, "made_up_metric"))).toEqual([]);
  });
});

describe("surveys (0005 header)", () => {
  const latest = async () => (await ctx.db.select().from(surveys)
    .where(and(eq(surveys.eventId, eventId), eq(surveys.blueprintKey, "survey_attendee")))).sort((a, b) => a.version - b.version);
  const questionsOf = async (id: string) => (await ctx.db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, id))).sort((a, b) => a.position - b.position);
  const apply = async (sv: ReturnType<typeof survey>) =>
    mod.applyProposal({ proposalId: (await propose(ORG_A, eventId, ops.surveysProposal([sv as never]))).id, organizationId: ORG_A, actorId: U.ownerA });

  it("creates a DRAFT v1 header with title, intro, target and a fingerprint of the stored survey", async () => {
    expect((await apply(survey())).created).toEqual({ survey: 1 });
    const [s] = await latest();
    expect(s).toMatchObject({ version: 1, status: "DRAFT", title: "Katılımcı anketi", intro: "Bu anket yaklaşık 3 dakika sürer.",
      targetResponses: 50, isAiGenerated: true, audience: "ATTENDEE", organizationId: ORG_A });
    const qs = await questionsOf(s!.id);
    expect(qs.map((q) => [q.position, q.questionKey, q.type, q.isMandatory])).toEqual([[0, "q_nps", "NPS_0_10", true], [1, "x_reason", "SINGLE_CHOICE", false]]);
    expect(qs[0]!.metadata).toEqual({ measures: ["nps"], origin: "BANK" });
    expect(qs[1]!.options).toEqual([{ value: "music", label: "Müzik" }, { value: "food", label: "Yemek" }]);
    expect(s!.aiFingerprint).toBe(await mod.persistedSurveyFingerprint(ctx.db, ORG_A, s!.id));
    for (const q of qs)
      expect(q.aiFingerprint).toBe(mod.fingerprint({ key: q.questionKey, type: q.type, text: q.questionText, required: q.isMandatory,
        options: q.options, isSensitive: q.isSensitive, metadata: q.metadata }));
  });

  it("an untouched AI draft is updated in place (same id, questions replaced)", async () => {
    const [before] = await latest();
    const r = await apply(survey({ title: "Katılımcı anketi v2", questions: [survey().questions[0]] }));
    expect(r.updated).toEqual({ survey: 1 });
    const all = await latest();
    expect(all.map((s) => [s.id, s.version, s.title])).toEqual([[before!.id, 1, "Katılımcı anketi v2"]]);
    expect((await questionsOf(before!.id)).map((q) => q.questionKey)).toEqual(["q_nps"]);
    expect(all[0]!.aiFingerprint).toBe(await mod.persistedSurveyFingerprint(ctx.db, ORG_A, before!.id));
  });

  it("a draft a person edited (header or a question) is preserved", async () => {
    const [s] = await latest();
    await ctx.db.update(surveys).set({ intro: "Organizatörün yazdığı giriş." }).where(eq(surveys.id, s!.id));
    expect((await apply(survey({ title: "AI başlığı" }))).preserved).toEqual({ survey: 1 });
    expect((await latest())[0]).toMatchObject({ title: "Katılımcı anketi v2", intro: "Organizatörün yazdığı giriş." });

    await ctx.db.update(surveys).set({ intro: "Bu anket yaklaşık 3 dakika sürer." }).where(eq(surveys.id, s!.id)); // back to the AI text
    await ctx.db.update(surveyQuestions).set({ questionText: "Bizi arkadaşlarınıza önerir misiniz?" }).where(eq(surveyQuestions.surveyId, s!.id));
    expect((await apply(survey({ title: "AI başlığı" }))).preserved).toEqual({ survey: 1 });
    expect((await questionsOf(s!.id))[0]!.questionText).toBe("Bizi arkadaşlarınıza önerir misiniz?");
  });

  it("an opened survey is never rewritten: a new DRAFT version is created beside it", async () => {
    const [v1] = await latest();
    await ctx.db.update(surveys).set({ status: "OPEN" }).where(eq(surveys.id, v1!.id));
    const v1Questions = await questionsOf(v1!.id);
    expect((await apply(survey({ title: "Anket v3" }))).created).toEqual({ survey: 1 });
    const all = await latest();
    expect(all.map((s) => [s.version, s.status, s.title])).toEqual([[1, "OPEN", "Katılımcı anketi v2"], [2, "DRAFT", "Anket v3"]]);
    expect(await questionsOf(v1!.id)).toEqual(v1Questions);
    expect((await questionsOf(all[1]!.id)).map((q) => q.questionKey)).toEqual(["q_nps", "x_reason"]);
  });
});

describe("unsupported operations: refused before the transaction, never skipped", () => {
  const fresh = "budget_variance"; // not used by any earlier test
  const mixed = (): Draft => ({
    kind: "blueprint.budget_risks", title: "karışık", rationale: null,
    operations: [
      { op: "upsert", entity: "kpi", data: kpi(fresh) },
      { op: "upsert", entity: "budget_line", data: { key: "venue", direction: "EXPENSE", category: "venue", label: "Mekân", plannedAmountMinor: 100, notes: null } },
      { op: "upsert", entity: "risk", data: { key: "rain", title: "Yağmur", description: null, category: "weather", likelihood: 3, impact: 4, mitigation: null, ownerRole: null } },
    ],
  });

  it("selecting an unsupported operation changes nothing (no claim, no error_message, no rows)", async () => {
    expect(await ctx.db.select().from(eventKpis).where(and(eq(eventKpis.eventId, eventId), eq(eventKpis.metricName, fresh)))).toEqual([]);
    const p = await propose(ORG_A, eventId, mixed());
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/budget_line.*risk/) });
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA, opIndexes: [0, 2] })).rejects.toMatchObject({ code: "INVALID" });
    expect(await proposalRow(p.id)).toMatchObject({ status: "PENDING", decidedAt: null, decidedBy: null, errorMessage: null, appliedOps: null });
    expect(await ctx.db.select().from(eventKpis).where(and(eq(eventKpis.eventId, eventId), eq(eventKpis.metricName, fresh)))).toEqual([]);
  });

  it("when the organizer unticks them, the selected supported operations are applied", async () => {
    const p = await propose(ORG_A, eventId, mixed());
    const r = await mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA, opIndexes: [0] });
    expect(r).toMatchObject({ applied: 1, created: { kpi: 1 } });
    expect((await proposalRow(p.id)).appliedOps).toEqual([0]);
  });

  it("registration operations (ticket_type, form_field) are refused the same way", async () => {
    const { ticketTypeSchema, formFieldSchema } = await import("@/lib/ai/schemas/event-config");
    const ticket = ticketTypeSchema.parse({ key: "genel", name: "Genel", description: null, pricing: "FREE", priceAmountMinor: null,
      currency: "TRY", quantity: null, maxPerOrder: 4, requiresApproval: false, eligibility: null, validDayIndexes: [], sortOrder: 0 });
    const field = formFieldSchema.parse({ key: "telefon", type: "PHONE", label: "Telefon", labelEn: null, helpText: null, required: false,
      options: null, validation: null, visibleForTicketKeys: [], isSensitive: false, origin: "EXPLICIT", rationale: null, sortOrder: 0 });
    const p = await propose(ORG_A, eventId, ops.registrationProposal([ticket], [field], []));
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA }))
      .rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/#0 ticket_type, #1 form_field/) });
    expect(await proposalRow(p.id)).toMatchObject({ status: "PENDING", errorMessage: null, decidedAt: null });
  });
});

describe("task_patch", () => {
  let taskId = "";
  beforeAll(async () => {
    taskId = (await ctx.db.select().from(tasks).where(and(eq(tasks.eventId, eventId), eq(tasks.blueprintKey, "task_gamma"))))[0]!.id;
  });
  const patch = (p: object, id = taskId): Draft => ({ kind: "copilot.update_task", title: "t", rationale: null, operations: [{ op: "update", entity: "task_patch", id, patch: p }] });
  const task = async () => (await ctx.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  it("BLOCKED and CANCELLED are refused before the transaction", async () => {
    for (const status of ["BLOCKED", "CANCELLED"]) {
      const p = await propose(ORG_A, eventId, patch({ status }));
      await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "INVALID", message: expect.stringContaining(status) });
      expect(await proposalRow(p.id)).toMatchObject({ status: "PENDING", errorMessage: null });
    }
    expect((await task()).status).toBe("TODO");
  });

  it("cannot assign a person from another organization; a member can be assigned", async () => {
    const bad = await propose(ORG_A, eventId, patch({ assigneeId: U.ownerB }));
    await expect(mod.applyProposal({ proposalId: bad.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await task()).assignedTo).toBeNull();
    await mod.applyProposal({ proposalId: (await propose(ORG_A, eventId, patch({ assigneeId: U.staffA, priority: "LOW", dueAt: "2027-04-01" }))).id, organizationId: ORG_A, actorId: U.ownerA });
    expect(await task()).toMatchObject({ assignedTo: U.staffA, priority: "LOW", dueDate: "2027-04-01", completedAt: null });
  });

  it("DONE sets completed_at; a DONE task is then preserved", async () => {
    const r = await mod.applyProposal({ proposalId: (await propose(ORG_A, eventId, patch({ status: "DONE" }))).id, organizationId: ORG_A, actorId: U.ownerA });
    expect(r.updated).toEqual({ task: 1 });
    const done = await task();
    expect(done.status).toBe("DONE");
    expect(done.completedAt).toBeInstanceOf(Date);
    const p2 = await propose(ORG_A, eventId, patch({ status: "TODO", title: "Yeniden aç" }));
    const r2 = await mod.applyProposal({ proposalId: p2.id, organizationId: ORG_A, actorId: U.ownerA });
    expect(r2).toEqual({ eventId, applied: 1, created: {}, updated: {}, preserved: { task: 1 } });
    expect(await proposalRow(p2.id)).toMatchObject({ status: "APPROVED", appliedSummary: r2 });
    expect(await task()).toMatchObject({ status: "DONE", title: done.title, completedAt: done.completedAt });
  });

  it("a task of another event or organization is a CONFLICT", async () => {
    const [tb] = await ctx.db.insert(tasks).values({ organizationId: ORG_B, eventId: eventB, title: "B görevi" }).returning();
    const p = await propose(ORG_A, eventId, patch({ title: "Ele geçir" }, tb!.id));
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await ctx.db.select().from(tasks).where(eq(tasks.id, tb!.id)))[0]!.title).toBe("B görevi");
  });
});

describe("authorization and tenancy in the service", () => {
  const kp = () => ops.kpisProposal([kpi(METRIC_LIBRARY[1]!.key)], []);
  it("the role is re-checked inside the transaction: a decider demoted after the pre-check is refused and nothing is written", async () => {
    // PGlite runs one session at a time, so a real concurrent demotion cannot be staged. Instead a test-only
    // trigger demotes the decider during the claim UPDATE — inside the apply transaction, after the
    // pre-check passed and before the in-transaction check runs. Without the second check this apply would succeed.
    await ctx.pg.exec(`
      create function test_demote_decider() returns trigger language plpgsql as $$
      begin
        if old.status = 'PENDING' and new.status = 'APPROVED' then update users set role = 'staff' where id = new.decided_by; end if;
        return new;
      end $$;
      create trigger test_demote_decider before update on proposals for each row execute function test_demote_decider();`);
    try {
      const p = await propose(ORG_A, null, ops.coreProposal(core));
      const eventsBefore = (await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length;
      await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: ADMIN_A })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await proposalRow(p.id)).toMatchObject({ status: "PENDING", decidedBy: null, decidedAt: null, errorMessage: null, eventId: null });
      expect((await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length).toBe(eventsBefore);
      expect((await ctx.db.select().from(users).where(eq(users.id, ADMIN_A)))[0]!.role).toBe("admin"); // demotion rolled back too
    } finally {
      await ctx.pg.exec("drop trigger test_demote_decider on proposals; drop function test_demote_decider();");
    }
  });

  it("staff may not apply or reject; nothing changes", async () => {
    const { ORG_PERMISSIONS } = await import("@/server/auth/org-access");
    expect(ORG_PERMISSIONS["proposal.decide"]).not.toContain("staff");
    const core0 = await propose(ORG_A, null, ops.coreProposal(core));
    await expect(mod.applyProposal({ proposalId: core0.id, organizationId: ORG_A, actorId: U.staffA, opIndexes: [0] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await proposalRow(core0.id)).toMatchObject({ status: "PENDING", eventId: null, errorMessage: null });
    const p = await propose(ORG_A, eventId, kp());
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.staffA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mod.rejectProposal(p.id, ORG_A, U.staffA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await proposalRow(p.id)).toMatchObject({ status: "PENDING", errorMessage: null, decidedBy: null });
    expect(mod.APPLY_ROLES).toEqual(["owner", "admin"]);
  });
  it("another tenant: wrong org → NOT_FOUND, right org but not a member → FORBIDDEN", async () => {
    const p = await propose(ORG_A, eventId, kp());
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_B, actorId: U.ownerB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerB })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mod.rejectProposal(p.id, ORG_B, U.ownerB)).rejects.toMatchObject({ code: "NOT_PENDING" }); // not visible in B
    await expect(mod.rejectProposal(p.id, ORG_A, U.ownerB)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await proposalRow(p.id)).status).toBe("PENDING");
  });
  it("a proposal cannot even be stored against another tenant's event (composite FK)", async () => {
    expect(await outcome(propose(ORG_A, eventB, kp()))).toMatch(/proposals_event_same_org_fk/);
  });
  it("owner/admin can reject; a decided proposal cannot be decided again", async () => {
    const p = await propose(ORG_A, eventId, kp());
    await mod.rejectProposal(p.id, ORG_A, ADMIN_A);
    expect(await proposalRow(p.id)).toMatchObject({ status: "REJECTED", decidedBy: ADMIN_A });
    expect(errors.toApiProposalStatus("REJECTED")).toBe("REJECTED");
    await expect(mod.rejectProposal(p.id, ORG_A, U.ownerA)).rejects.toMatchObject({ code: "NOT_PENDING" });
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "NOT_PENDING", message: "Proposal is REJECTED" });
  });
});

describe("validation, expiry, selection", () => {
  it("tampered operations are rejected and the proposal is marked FAILED", async () => {
    const p = await propose(ORG_A, eventId, { kind: "blueprint.tasks", title: "t", rationale: null, operations: [{ op: "upsert", entity: "task", data: { key: "DROP TABLE", title: "x" } }] });
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "INVALID" });
    expect(await proposalRow(p.id)).toMatchObject({ status: "FAILED", errorMessage: expect.stringMatching(/^Invalid operations/) });
  });
  it("a payload without operations is FAILED too", async () => {
    const [p] = await ctx.db.insert(proposals).values({ organizationId: ORG_A, eventId, kind: "blueprint.tasks", title: "t", schemaVersion: "v",
      payload: { tasks: [] }, aiFingerprint: fp("legacy-shape"), expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    await expect(mod.applyProposal({ proposalId: p!.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "INVALID" });
    expect((await proposalRow(p!.id)).status).toBe("FAILED");
  });
  it("expired proposals cannot be applied", async () => {
    const p = await propose(ORG_A, eventId, ops.kpisProposal([kpi(METRIC_LIBRARY[2]!.key)], []), { createdAt: new Date(Date.now() - 10_000), expiresAt: new Date(Date.now() - 1000) });
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "EXPIRED" });
    expect(await proposalRow(p.id)).toMatchObject({ status: "EXPIRED", decidedAt: null });
  });
  it("empty or out-of-range selections are refused; NO_EVENT without an event", async () => {
    const p = await propose(ORG_A, eventId, ops.kpisProposal([kpi(METRIC_LIBRARY[3]!.key), kpi(METRIC_LIBRARY[4]!.key)], []));
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA, opIndexes: [] })).rejects.toMatchObject({ code: "INVALID" });
    await expect(mod.applyProposal({ proposalId: p.id, organizationId: ORG_A, actorId: U.ownerA, opIndexes: [5] })).rejects.toMatchObject({ code: "INVALID" });
    const noEvent = await propose(ORG_A, null, ops.kpisProposal([kpi(METRIC_LIBRARY[3]!.key)], []));
    await expect(mod.applyProposal({ proposalId: noEvent.id, organizationId: ORG_A, actorId: U.ownerA })).rejects.toMatchObject({ code: "NO_EVENT" });
    expect((await proposalRow(noEvent.id)).status).toBe("PENDING");
  });
});

describe("HTTP error mapping (unchanged responses)", () => {
  it("maps codes to the same statuses and bodies", async () => {
    const { toErrorResponse } = await import("@/server/http");
    const expected = { NOT_FOUND: 404, NOT_PENDING: 409, CONFLICT: 409, NO_EVENT: 409, INVALID: 422, FORBIDDEN: 403, EXPIRED: 410 } as const;
    for (const [code, status] of Object.entries(expected) as [keyof typeof expected, number][]) {
      const res = toErrorResponse(new errors.ProposalError(code, `m-${code}`));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: `m-${code}`, code });
    }
    expect(mod.ProposalError).toBe(errors.ProposalError);
  });
});
