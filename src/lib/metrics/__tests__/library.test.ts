import { describe, expect, it } from "vitest";
import { METRIC_LIBRARY, candidateMetrics, type MetricSeed } from "@/lib/metrics/library";
import { QUESTION_BANK, surveyQuestionSchema } from "@/lib/metrics/question-bank";
import { dataAvailableFrom, validateMetricLibrary } from "@/lib/metrics/validate";
import { kpisProposal } from "@/lib/ai/blueprint/operations";
import { buildKpisDraftSchema } from "@/lib/ai/blueprint/sections/kpis";

describe("Metric Evidence Registry", () => {
  it("the shipped library passes validation (ids, refs, formats, inputs)", () => {
    expect(validateMetricLibrary()).toEqual([]);
  });
  it("has exactly the 26 defined metrics — no additions", () => {
    expect(METRIC_LIBRARY).toHaveLength(26);
  });
  it("validation catches duplicates, dangling modules and uncollectable survey metrics", () => {
    const base = METRIC_LIBRARY[0] as MetricSeed;
    const issues = validateMetricLibrary([
      base, base,
      { ...base, key: "bad_module", requiresModule: "nope" as never },
      { ...base, key: "orphan_survey", dataSources: ["SURVEY"] },
      { ...base, key: "bad_group", anyOf: [["SURVEY", "CHECKIN"]] },
    ]);
    const text = issues.map((i) => `${i.key}: ${i.issue}`).join("\n");
    expect(text).toMatch(/registrations_confirmed: duplicate key/);
    expect(text).toMatch(/bad_module/);
    expect(text).toMatch(/orphan_survey: SURVEY source but no question-bank entry/);
    expect(text).toMatch(/bad_group: anyOf source SURVEY not in dataSources/);
  });
  it("every bank question passes the strict survey-question schema", () => {
    for (const e of Object.values(QUESTION_BANK)) for (const q of e!.questions) expect(surveyQuestionSchema.safeParse(q).success).toBe(true);
  });
  it("selection is constrained: only library keys can be emitted, module gating applies", () => {
    const schema = buildKpisDraftSchema(candidateMetrics("CONGRESS", ["core", "registration"]).map((m) => m.key));
    expect(schema.safeParse({ kpis: [{ metricKey: "made_up_kpi", objectiveIndex: null, target: null, targetBasis: null, rationale: "x" }] }).success).toBe(false);
    expect(schema.safeParse({ kpis: [{ metricKey: "attributable_visitor_spend", objectiveIndex: null, target: null, targetBasis: null, rationale: "x" }] }).success).toBe(false);
    expect(schema.safeParse({ kpis: [{ metricKey: "nps", objectiveIndex: null, target: null, targetBasis: null, rationale: "x" }] }).success).toBe(true);
  });
  it("availability respects 'any of' sources (manual counts arrive before external APIs)", () => {
    const get = (k: string) => METRIC_LIBRARY.find((m) => m.key === k) as MetricSeed;
    expect(dataAvailableFrom(get("press_mentions"))).toBe("V0.3");
    expect(dataAvailableFrom(get("social_engagement_rate"))).toBe("V1.0");
    expect(dataAvailableFrom(get("session_rating_mean"))).toBe("V0.4");
  });
});

describe("evidence is never presented as validated", () => {
  const kpis = [{ metricKey: "nps", objectiveIndex: null, target: null, targetBasis: null, rationale: "r" }];
  it("unknown or unreviewed status is stated on the proposal card", () => {
    expect(kpisProposal(kpis, []).rationale).toMatch(/hiçbiri henüz literatür incelemesinden geçmedi/);
    expect(kpisProposal(kpis, [], { nps: "IN_REVIEW" }).rationale).toMatch(/literatür incelemesinden geçmedi/);
  });
  it("only REVIEWED removes the notice", () => {
    expect(kpisProposal(kpis, [], { nps: "REVIEWED" }).rationale).toBeNull();
  });
});
