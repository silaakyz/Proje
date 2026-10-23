import { describe, expect, it } from "vitest";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { normalizeBlueprintCore, blueprintCoreDraftSchema, type BlueprintCore, type BlueprintCoreDraft } from "@/lib/ai/blueprint/core";
import { buildCoreSystemPrompt } from "@/lib/ai/blueprint/prompts";
import { buildTasksDraftSchema, normalizeTasks } from "@/lib/ai/blueprint/sections/tasks";
import { buildKpisDraftSchema, deriveDataRequirements, deriveMeasurementTasks, normalizeKpis } from "@/lib/ai/blueprint/sections/kpis";
import { buildSurveysDraftSchema, normalizeSurveys } from "@/lib/ai/blueprint/sections/surveys";
import { buildBudgetRisksDraftSchema } from "@/lib/ai/blueprint/sections/budget-risks";
import { registrationDraftSchema } from "@/lib/ai/blueprint/sections/registration";
import { proposalOperationsSchema, tasksProposal } from "@/lib/ai/blueprint/operations";
import * as D from "@/lib/domain/enums";
import type { OrganizerTypeValue } from "@/lib/domain/enums";
import { METRIC_LIBRARY, candidateMetrics } from "@/lib/metrics/library";
import { QUESTION_BANK, SPEND_CATEGORIES, surveyQuestionSchema } from "@/lib/metrics/question-bank";
import { MODULES, defaultModulesFor, getModule, recommendedModulesFor, vocabularyFor } from "@/lib/modules/registry";

const TODAY = "2026-10-16";
const sys = buildCoreSystemPrompt({ today: TODAY, orgName: "X", organizationType: "MUNICIPALITY" });
const festivalExample: BlueprintCoreDraft = JSON.parse(sys.split("<response>")[1]!.split("</response>")[0]!);

const conferenceDraft: BlueprintCoreDraft = {
  event: { title: "İstanbul Yapay Zekâ Konferansı", summary: null, format: "CONFERENCE", deliveryMode: "IN_PERSON", primaryLanguage: "en",
    bilingual: true, city: "İstanbul", venueName: null, startDate: "2027-05-12", durationDays: 2, dailyStartTime: "09:00",
    dailyEndTime: "18:00", expectedAttendance: 800, capacity: null },
  objectives: [{ text: "Uluslararası araştırmacıları bir araya getirmek", origin: "EXPLICIT" }],
  audience: "Araştırmacılar ve sektör profesyonelleri", clientOrganizerType: null, clientName: null, budgetTotalTry: null,
  proposedModules: [{ key: "stages", reason: "x" }, { key: "sponsorship", reason: "Sponsor alanı istendi." }],
  stakeholders: [], clarifications: [], assumptions: [],
};

const coreOf = (d: BlueprintCoreDraft, organizationType: OrganizerTypeValue = "MUNICIPALITY"): BlueprintCore => {
  const r = normalizeBlueprintCore(d, { today: TODAY, organizationType });
  if (!r.ok) throw new Error(JSON.stringify(z.treeifyError(r.error)));
  return r.core;
};

describe("registry & libraries", () => {
  it("domain enum lists match the database enums of the latest Drizzle migration", () => {
    // The Drizzle migration snapshot records the enum values the migrations actually create in PostgreSQL.
    const meta = path.resolve(__dirname, "../../../../../drizzle/meta");
    const journal = JSON.parse(fs.readFileSync(path.join(meta, "_journal.json"), "utf8")) as { entries: { idx: number }[] };
    const last = Math.max(...journal.entries.map((e) => e.idx));
    const snapshot = JSON.parse(fs.readFileSync(path.join(meta, `${String(last).padStart(4, "0")}_snapshot.json`), "utf8")) as {
      enums: Record<string, { values: string[] }>;
    };
    const dbEnum = (name: string) => [...snapshot.enums[`public.${name}`]!.values].sort();
    expect([...D.ORGANIZER_TYPES].sort()).toEqual(dbEnum("organizer_type"));
    expect([...D.EVENT_PHASES].sort()).toEqual(dbEnum("event_phase"));
    expect([...D.SURVEY_AUDIENCES].sort()).toEqual(dbEnum("survey_audience"));
    expect([...D.TASK_BOARDS].sort()).toEqual(dbEnum("task_board"));
    expect([...D.TASK_PRIORITIES].sort()).toEqual(dbEnum("task_priority"));
    expect([...SPEND_CATEGORIES].sort()).toEqual(dbEnum("spend_category"));
  });
  it("domain-only enums (stored in ai_config / code, not as database enums) are non-empty and unique", () => {
    for (const list of [D.EVENT_FORMATS, D.DELIVERY_MODES, D.STAKEHOLDER_KINDS, D.METRIC_CATEGORIES, D.METRIC_DATA_SOURCES]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });
  it("module keys and workstream keys are unique", () => {
    expect(new Set(MODULES.map((m) => m.key)).size).toBe(MODULES.length);
    const ws = MODULES.flatMap((m) => m.workstreams.map((w) => w.key));
    expect(new Set(ws).size).toBe(ws.length);
  });
  it("every metric's required module exists and every bank entry refers to a library metric", () => {
    for (const m of METRIC_LIBRARY) if (m.requiresModule) expect(getModule(m.requiresModule)).toBeDefined();
    const keys = new Set<string>(METRIC_LIBRARY.map((m) => m.key));
    for (const k of Object.keys(QUESTION_BANK)) expect(keys.has(k)).toBe(true);
    // The survey question contract accepts exactly the spend categories (database enum spend_category, 0007).
    const spend: readonly string[] = surveyQuestionSchema.shape.spendCategory.unwrap().options;
    expect([...spend]).toEqual([...SPEND_CATEGORIES]);
    expect(spend.length).toBeGreaterThan(0);
    for (const b of Object.values(QUESTION_BANK)) for (const q of b!.questions) if (q.spendCategory) expect(spend).toContain(q.spendCategory);
  });
});

describe("core stage: format, organizer type and module compatibility", () => {
  it("festival by a municipality: format defaults + grounded proposals, Adana → TR62", () => {
    const c = coreOf(festivalExample);
    expect(c.modules.map((m) => m.key)).toEqual(
      ["core", "registration", "stages", "site_operations", "booths", "sponsorship", "economic_impact", "community_impact"]);
    expect(c.event).toMatchObject({ format: "FESTIVAL", provinceCode: 1, nuts2Code: "TR62" });
    expect(c.organizer).toEqual({ organizationType: "MUNICIPALITY", clientOrganizerType: null, clientName: null, effectiveType: "MUNICIPALITY" });
  });
  it("a conference may have a stage (compatibility, not an allow-list)", () => {
    const r = normalizeBlueprintCore(conferenceDraft, { today: TODAY, organizationType: "UNIVERSITY" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.core.modules.map((m) => m.key)).toEqual(expect.arrayContaining(["sessions", "speakers", "stages", "sponsorship"]));
    expect(r.core.modules.find((m) => m.key === "stages")).toMatchObject({ source: "AI_PROPOSED" });
  });
  it("a festival may have speakers; their session dependency is added automatically", () => {
    const c = coreOf({ ...festivalExample, proposedModules: [{ key: "speakers", reason: "Söyleşi programı var." }] });
    const keys = c.modules.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(["speakers", "sessions"]));
    expect(c.modules.find((m) => m.key === "sessions")).toMatchObject({ source: "DEPENDENCY" });
  });
  it("only genuine conflicts are blocked: no site operations or visitor-spend impact for a virtual event", () => {
    const r = normalizeBlueprintCore(
      { ...conferenceDraft, event: { ...conferenceDraft.event, deliveryMode: "VIRTUAL" },
        proposedModules: [{ key: "site_operations", reason: "x" }, { key: "economic_impact", reason: "y" }, { key: "booths", reason: "Sanal stantlar." }] },
      { today: TODAY, organizationType: "COMPANY" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys = r.core.modules.map((m) => m.key);
    expect(keys).not.toContain("site_operations");
    expect(keys).not.toContain("economic_impact");
    expect(keys).toContain("booths");
    expect(r.repairs.join()).toMatch(/not available for VIRTUAL/);
  });
  it("AI module proposals need a reason", () => {
    const r = normalizeBlueprintCore({ ...conferenceDraft, proposedModules: [{ key: "booths", reason: "  " }] }, { today: TODAY, organizationType: "COMPANY" });
    expect(r.ok && r.core.modules.map((m) => m.key)).not.toContain("booths");
  });
  it("organizer type comes from the organization; a client is recorded only when stated", () => {
    const c = coreOf({ ...festivalExample, clientOrganizerType: "MUNICIPALITY", clientName: "Seyhan Belediyesi" }, "EVENT_AGENCY");
    expect(c.organizer).toEqual({ organizationType: "EVENT_AGENCY", clientOrganizerType: "MUNICIPALITY", clientName: "Seyhan Belediyesi", effectiveType: "MUNICIPALITY" });
  });
  it("organizer type drives recommendations, never restrictions", () => {
    const uni = recommendedModulesFor({ format: "FESTIVAL", deliveryMode: "IN_PERSON", organizerType: "UNIVERSITY" });
    expect(uni).toEqual(expect.arrayContaining(["sessions", "speakers"]));
    const muni = recommendedModulesFor({ format: "CONGRESS", deliveryMode: "IN_PERSON", organizerType: "MUNICIPALITY" });
    expect(muni).toEqual(expect.arrayContaining(["economic_impact", "community_impact"]));
  });
  it("different formats get different workspaces", () => {
    const f = vocabularyFor(defaultModulesFor({ format: "FESTIVAL", deliveryMode: "IN_PERSON" })).workstreams;
    const c = vocabularyFor(defaultModulesFor({ format: "CONGRESS", deliveryMode: "IN_PERSON" })).workstreams;
    expect(f).toContain("stage_production");
    expect(c).toContain("call_for_papers");
    expect(f).not.toContain("call_for_papers");
  });
});

describe("tasks stage", () => {
  const core = coreOf({ ...conferenceDraft, proposedModules: [] });
  const base = { description: null, assigneeRole: null, stakeholderKind: null, priority: "HIGH" as const };
  const r = normalizeTasks({ assumptions: [], tasks: [
    { ...base, key: "venue_rent", title: "Mekânı kirala", workstream: "venue", board: "PLANNING", phase: "PLAN", dueOffsetDays: -120, dependsOnKeys: ["budget_ok"] },
    { ...base, key: "budget_ok", title: "Bütçeyi onayla", workstream: "finance", board: "PLANNING", phase: "PLAN", dueOffsetDays: -150, dependsOnKeys: ["venue_rent"] },
    { ...base, key: "desk_setup", title: "Kayıt masasını kur", workstream: "made_up", board: "OPERATIONS", phase: "PLAN", dueOffsetDays: 0, dependsOnKeys: ["venue_rent", "zzz"] },
  ] }, core);
  it("breaks dependency cycles and drops unknown deps", () => {
    const a = r.tasks.find((t) => t.key === "venue_rent")!;
    const b = r.tasks.find((t) => t.key === "budget_ok")!;
    expect(a.dependsOnKeys.includes("budget_ok") && b.dependsOnKeys.includes("venue_rent")).toBe(false);
    expect(r.repairs.join()).toMatch(/cyclic/);
    expect(r.tasks.find((t) => t.key === "desk_setup")!.dependsOnKeys).toEqual(["venue_rent"]);
  });
  it("repairs workstream and phase, computes due dates", () => {
    expect(r.tasks.find((t) => t.key === "desk_setup")).toMatchObject({ workstream: "strategy", phase: "RUN", dueDate: "2027-05-12" });
    expect(r.tasks.find((t) => t.key === "venue_rent")!.dueDate).toBe("2027-01-12");
  });
  it("produces operations that pass the apply schema", () => {
    expect(proposalOperationsSchema.safeParse(tasksProposal(r.tasks, []).operations).success).toBe(true);
  });
});

describe("KPI → data requirements → surveys", () => {
  const festival = coreOf({ ...festivalExample, event: { ...festivalExample.event, startDate: "2027-04-22" } });
  it("only offers metrics whose module is enabled", () => {
    const conf = candidateMetrics("CONFERENCE", defaultModulesFor({ format: "CONFERENCE", deliveryMode: "IN_PERSON" })).map((m) => m.key);
    expect(conf).toContain("session_rating_mean");
    expect(conf).not.toContain("attributable_visitor_spend");
    expect(candidateMetrics("FESTIVAL", festival.modules.map((m) => m.key)).map((m) => m.key)).toContain("attributable_visitor_spend");
  });
  const k = normalizeKpis({ kpis: [
    { metricKey: "attributable_visitor_spend", objectiveIndex: 0, target: null, targetBasis: null, rationale: "r" },
    { metricKey: "attributable_visitor_spend", objectiveIndex: 0, target: null, targetBasis: null, rationale: "dup" },
    { metricKey: "nps", objectiveIndex: 9, target: 150, targetBasis: "x", rationale: "r" },
    { metricKey: "accessibility_satisfaction", objectiveIndex: null, target: null, targetBasis: null, rationale: "r" },
  ] }, festival);
  it("dedupes, rejects bad objective indexes and out-of-range targets, flags uncovered objectives", () => {
    expect(k.kpis.map((x) => x.metricKey)).toEqual(["attributable_visitor_spend", "nps", "accessibility_satisfaction"]);
    expect(k.kpis[1]).toMatchObject({ objectiveIndex: null, target: null });
    expect(k.warnings.join()).toMatch(/Yerel üreticileri/);
  });
  const req = deriveDataRequirements(k.kpis);
  it("derives audience sample sizes and measurement tasks", () => {
    expect(req.surveys).toEqual([{ audience: "ATTENDEE", minResponses: 200, metricKeys: ["attributable_visitor_spend", "nps", "accessibility_satisfaction"] }]);
    const m = deriveMeasurementTasks(req, festival);
    expect(m.map((t) => t.key)).toEqual(["m_survey_attendee_finalize", "m_survey_attendee_collect", "m_report_draft"]);
    expect(m[1]!.dueDate).toBe("2027-04-28"); // last day (25th) + 3
  });
  it("injects bank questions, KVKK consent gate, and dedupes model questions", () => {
    const s = normalizeSurveys({ surveys: [{ audience: "ATTENDEE", title: "T", intro: "I", extraQuestions: [
      { key: "nps", type: "NPS_0_10", text: "Tekrar NPS", options: null, required: true },
      { key: "food_quality", type: "LIKERT_5", text: "Yeme-içme alanlarının kalitesi", options: null, required: false },
      { key: "bad_choice", type: "SINGLE_CHOICE", text: "Seçeneksiz soru", options: null, required: false },
    ] }] }, festival, k.kpis, req);
    const att = s.surveys.find((x) => x.audience === "ATTENDEE")!;
    const keys = att.questions.map((q) => q.key);
    expect(keys[0]).toBe("q_kvkk_special_consent");
    expect(keys).toEqual(expect.arrayContaining(["q_nps", "q_would_visit_anyway", "q_access_need", "x_food_quality", "x_nps"]));
    expect(keys).not.toContain("x_bad_choice");
    expect(att.questions.find((q) => q.key === "q_access_need")!.showIf).toEqual({ key: "q_kvkk_special_consent", equals: true });
    expect(att.targetResponses).toBe(200);
  });
  it("marks a question sensitive by whole words only (\"standınıza\" is not \"din\")", () => {
    const s = normalizeSurveys({ surveys: [{ audience: "ATTENDEE", title: "T", intro: "I", extraQuestions: [
      { key: "q_a", type: "LIKERT_5", text: "Standınıza gelen ziyaretçi yoğunluğu", options: null, required: false },
      { key: "q_b", type: "LIKERT_5", text: "Kadın ve erkek katılımcı dengesi", options: null, required: false },
      { key: "q_c", type: "OPEN_TEXT", text: "Dini inancınız etkinliğe katılımınızı etkiledi mi?", options: null, required: false },
      { key: "q_d", type: "YES_NO", text: "Sağlık sorununuz var mı?", options: null, required: false },
    ] }] }, festival, k.kpis, req);
    const q = Object.fromEntries(s.surveys[0]!.questions.map((x) => [x.key, !!x.isSensitive]));
    expect([q.x_q_a, q.x_q_b, q.x_q_c, q.x_q_d]).toEqual([false, false, true, true]);
  });
});

describe("provider JSON Schemas", () => {
  const vocab = vocabularyFor(defaultModulesFor({ format: "FESTIVAL", deliveryMode: "IN_PERSON" }));
  const schemas: Record<string, z.ZodType> = {
    core: blueprintCoreDraftSchema,
    tasks: buildTasksDraftSchema(vocab.workstreams),
    kpis: buildKpisDraftSchema(METRIC_LIBRARY.map((m) => m.key)),
    surveys: buildSurveysDraftSchema(["ATTENDEE", "SPONSOR"]),
    budget_risks: buildBudgetRisksDraftSchema(vocab.workstreams),
    registration: registrationDraftSchema,
  };
  const walk = (n: unknown, visit: (o: Record<string, unknown>) => void): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((v) => walk(v, visit));
    const o = n as Record<string, unknown>;
    visit(o);
    for (const [k, v] of Object.entries(o)) {
      if (k === "properties" && v && typeof v === "object") Object.values(v).forEach((p) => walk(p, visit));
      else walk(v, visit);
    }
  };
  it.each(Object.keys(schemas))("%s: all properties required, no rejected keywords", (name) => {
    const js = z.toJSONSchema(schemas[name]!);
    walk(js, (o) => {
      if (o.type === "object" && o.properties)
        expect((o.required as string[]).sort()).toEqual(Object.keys(o.properties as object).sort());
      for (const k of ["pattern", "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) expect(o).not.toHaveProperty(k);
    });
  });
});
