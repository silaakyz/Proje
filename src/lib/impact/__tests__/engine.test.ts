import { describe, expect, it } from "vitest";
import { calculateImpact, type EngineInput, type EngineResponse } from "@/lib/impact/engine";

const visitor = (spendKurus: EngineResponse["spendKurus"], extra: Partial<EngineResponse> = {}): EngineResponse => ({
  weight: 1, isLocalResident: false, partySize: 2, daysPresent: 2, wouldVisitAnyway: "no", mainReason: "event", spendKurus, ...extra,
});
const local: EngineResponse = { weight: 1, isLocalResident: true, partySize: null, daysPresent: 1, wouldVisitAnyway: null, mainReason: null, spendKurus: {} };

// 200 visitors: party of 2, 2 days, 1,000 TL accommodation + 400 TL food for the party → 700 TL per person, 350 TL per day.
const visitors = Array.from({ length: 200 }, () => visitor({ ACCOMMODATION: 100_000, FOOD_BEVERAGE: 40_000 }));
const locals = Array.from({ length: 200 }, () => local);

const input: EngineInput = {
  requestedLevel: "ECONOMIC_IMPACT",
  attendance: { basis: "CHECKIN", value: 10_000 },
  responses: [...visitors, ...locals],
  assumptions: {
    priceYear: 2026,
    attributionMethod: "RECORDED_DEADWEIGHT",
    deadweight: { value: 0.2, source: "Test: kayıtlı deadweight kaynağı" },
    displacement: { value: 0.1, source: "Test: kayıtlı displacement kaynağı" },
    leakage: { value: 0.25, source: "Test: kayıtlı leakage kaynağı" },
  },
  eventNuts2Code: "TR31",
  multiplierSet: {
    id: "ms", nuts2Code: "TR31", isActive: true, method: "FLQ", priceYear: 2026,
    coefficients: [
      { spendCategory: "ACCOMMODATION", output: 1.5, valueAdded: 0.6, income: 0.3, employmentPerMTry: 10 },
      { spendCategory: "FOOD_BEVERAGE", output: 1.8, valueAdded: 0.5, income: 0.25, employmentPerMTry: 20 },
    ],
  },
};

describe("impact engine", () => {
  it("computes every level from the library formulas and the recorded inputs", () => {
    const r = calculateImpact(input);
    expect(r).toMatchObject({ achievedLevel: "ECONOMIC_IMPACT", status: "SUCCEEDED" });
    expect(r.breakdown).toMatchObject({ visitorShare: 0.5, nonResidentVisitors: 5000, meanDaysPresent: 2, meanSpendPerVisitorDay: 350, spendSample: 200, trimmedOut: 0 });
    // 5,000 visitors × 2 days × 350 TL
    expect(r.figures).toEqual({
      grossDirectSpend: 3_500_000,
      attributableSpend: 2_520_000, // × 0.8 × 0.9
      // local demand: accommodation 1,800,000 × 0.75 = 1,350,000; food 720,000 × 0.75 = 540,000
      totalOutputImpact: 2_997_000, // 1,350,000 × 1.5 + 540,000 × 1.8
      totalValueAdded: 1_080_000, // × 0.6, × 0.5
      totalIncome: 540_000, // × 0.3, × 0.25
      totalEmploymentFte: 24.3, // 1.35 × 10 + 0.54 × 20
    });
    expect(r.breakdown!.byCategory.ACCOMMODATION).toMatchObject({ gross: 2_500_000, attributable: 1_800_000, localDemand: 1_350_000 });
  });

  it("a set without employment coefficients (e.g. from TÜİK's tables) reports no employment figure", () => {
    const coefficients = input.multiplierSet!.coefficients.map((c) => ({ ...c, employmentPerMTry: null }));
    const r = calculateImpact({ ...input, multiplierSet: { ...input.multiplierSet!, coefficients } });
    expect(r).toMatchObject({ achievedLevel: "ECONOMIC_IMPACT", status: "SUCCEEDED", figures: { totalOutputImpact: 2_997_000, totalIncome: 540_000 } });
    expect(r.figures).not.toHaveProperty("totalEmploymentFte");
    const mixed = calculateImpact({ ...input, multiplierSet: { ...input.multiplierSet!, coefficients: [coefficients[0]!, input.multiplierSet!.coefficients[1]!] } });
    expect(mixed.figures).not.toHaveProperty("totalEmploymentFte"); // never a partial employment total
  });

  it("stops at the requested level and produces no higher figure", () => {
    const r = calculateImpact({ ...input, requestedLevel: "SPEND" });
    expect(r).toMatchObject({ achievedLevel: "SPEND", status: "SUCCEEDED", figures: { grossDirectSpend: 3_500_000 } });
    expect(r.figures).not.toHaveProperty("attributableSpend");
  });

  it("trims per-person spend at the 1st/99th percentile", () => {
    const outliers = [visitor({ ACCOMMODATION: 20_000_000 }), visitor({ ACCOMMODATION: 30_000_000 })];
    const r = calculateImpact({ ...input, responses: [...visitors.slice(2), ...outliers, ...locals] });
    expect(r.breakdown).toMatchObject({ spendSample: 198, trimmedOut: 2, meanSpendPerVisitorDay: 350 });
  });

  it("a spend category without a coefficient blocks level 3 (no partial economic impact)", () => {
    const r = calculateImpact({ ...input, multiplierSet: { ...input.multiplierSet!, coefficients: input.multiplierSet!.coefficients.slice(0, 1) } });
    expect(r).toMatchObject({ achievedLevel: "ATTRIBUTABLE_SPEND", status: "INSUFFICIENT_DATA" });
    expect(r.checks.find((c) => c.check === "multipliers_cover_spend_categories")).toMatchObject({ passed: false });
    expect(r.figures).not.toHaveProperty("totalOutputImpact");
  });

  it("a different price year keeps level 3 (per-TRY ratios) but drops the employment figure", () => {
    const r = calculateImpact({ ...input, multiplierSet: { ...input.multiplierSet!, priceYear: 2023 } });
    expect(r).toMatchObject({ achievedLevel: "ECONOMIC_IMPACT", status: "SUCCEEDED", figures: { totalOutputImpact: 2_997_000, totalValueAdded: 1_080_000 } });
    expect(r.figures).not.toHaveProperty("totalEmploymentFte");
    expect(r.breakdown!.byCategory.ACCOMMODATION).not.toHaveProperty("employmentFte");
    expect(r.checks.find((c) => c.check === "price_years_match")).toMatchObject({ passed: false, required: 2026, actual: 2023 });
    // a set without employment coefficients has nothing the price year could affect: no such check
    const noEmp = input.multiplierSet!.coefficients.map((c) => ({ ...c, employmentPerMTry: null }));
    const r2 = calculateImpact({ ...input, multiplierSet: { ...input.multiplierSet!, priceYear: 2023, coefficients: noEmp } });
    expect(r2.achievedLevel).toBe("ECONOMIC_IMPACT");
    expect(r2.checks.find((c) => c.check === "price_years_match")).toBeUndefined();
  });

  it("too few usable responses: no figures at all", () => {
    const r = calculateImpact({ ...input, responses: [...visitors.slice(0, 100), ...locals] });
    expect(r).toMatchObject({ achievedLevel: null, status: "INSUFFICIENT_DATA", figures: null, breakdown: null });
    expect(r.counts).toMatchObject({ nonResidentWithSpend: 100 });
  });

  it("visitors who left every spend question blank are not spend responses", () => {
    const blank = Array.from({ length: 200 }, () => visitor({}));
    const r = calculateImpact({ ...input, responses: [...blank, ...locals] });
    expect(r.counts.nonResidentWithSpend).toBe(0);
    expect(r.achievedLevel).toBeNull();
  });

  describe("survey-measured attribution (strict rule, per spend category)", () => {
    const survey: Record<string, unknown> = { ...(input.assumptions as Record<string, unknown>), attributionMethod: "SURVEY_STRICT" };
    // 200 visitors: 100 strict (event, would not come), 50 "event and other"+"maybe", 50 "other"+"yes".
    // Strict visitors spend only on accommodation; the others on food only.
    const mixed = [
      ...Array.from({ length: 100 }, () => visitor({ ACCOMMODATION: 100_000 })),
      ...Array.from({ length: 50 }, () => visitor({ FOOD_BEVERAGE: 100_000 }, { mainReason: "event_and_other", wouldVisitAnyway: "maybe" })),
      ...Array.from({ length: 50 }, () => visitor({ FOOD_BEVERAGE: 100_000 }, { mainReason: "other", wouldVisitAnyway: "yes" })),
    ];

    it("attributes each category by the strict share of its own spend; deadweight is not needed", () => {
      const { deadweight: _dw, ...noDeadweight } = survey;
      const r = calculateImpact({ ...input, responses: [...mixed, ...locals], assumptions: noDeadweight });
      expect(r).toMatchObject({ achievedLevel: "ECONOMIC_IMPACT", status: "SUCCEEDED" });
      expect(r.checks.find((c) => c.check === "attribution_from_survey")).toMatchObject({ passed: true });
      expect(r.checks.find((c) => c.check === "deadweight_sourced")).toBeUndefined();
      // gross: 5,000 visitors × 2 days × 250 TL = 2,500,000 (accommodation 1,250,000, food 1,250,000)
      expect(r.figures!.grossDirectSpend).toBe(2_500_000);
      const by = r.breakdown!.byCategory;
      expect(by.ACCOMMODATION).toMatchObject({ gross: 1_250_000, attributable: 1_125_000 }); // share 1 × (1 − 0.1)
      expect(by.FOOD_BEVERAGE).toMatchObject({ gross: 1_250_000, attributable: 0 }); // no strict visitor bought food
      expect(r.figures!.attributableSpend).toBe(1_125_000);
      expect(r.breakdown!.attribution).toMatchObject({
        method: "SURVEY_STRICT", respondents: 200, strictRespondentShare: 0.5, strictSpendShare: 0.5,
        shareByCategory: { ACCOMMODATION: 1, FOOD_BEVERAGE: 0 },
        // broad rule adds the "event and other / maybe" group: food 1,250,000 × 0.5 × 0.9 = 562,500
        sensitivity: { rule: "BROAD", spendShare: 0.75, attributableSpend: 1_687_500 },
      });
      // level 3 on the strict figure: 1,125,000 × 0.75 × 1.5
      expect(r.figures!.totalOutputImpact).toBe(1_265_625);
      // sensitivity output: + 562,500 × 0.75 × 1.8
      expect((r.breakdown!.attribution as { sensitivity: { totalOutputImpact: number } }).sensitivity.totalOutputImpact).toBe(1_265_625 + 759_375);
    });

    it("a category no answering visitor spent on takes the overall strict share", () => {
      const noAnswer = Array.from({ length: 4 }, () => visitor({ RETAIL_SHOPPING: 100_000 }, { mainReason: null, wouldVisitAnyway: null }));
      const r = calculateImpact({ ...input, responses: [...mixed, ...noAnswer, ...locals], assumptions: survey,
        multiplierSet: { ...input.multiplierSet!, coefficients: [...input.multiplierSet!.coefficients,
          { spendCategory: "RETAIL_SHOPPING", output: 1, valueAdded: 0.5, income: 0.2, employmentPerMTry: null }] } });
      expect(r.breakdown!.attribution).toMatchObject({ respondents: 200, shareByCategory: { RETAIL_SHOPPING: 0.5 } });
    });

    it("everyone strict: the survey method equals a recorded deadweight of 0", () => {
      const a = calculateImpact({ ...input, assumptions: survey });
      const b = calculateImpact({ ...input, assumptions: { ...survey, attributionMethod: "RECORDED_DEADWEIGHT", deadweight: { value: 0, source: "Test: sıfır ölü ağırlık" } } });
      expect(a.figures).toEqual(b.figures);
    });

    it("the recorded-rate method without a deadweight stops at level 1", () => {
      const { deadweight: _dw, ...rest } = input.assumptions as Record<string, unknown>;
      const r = calculateImpact({ ...input, assumptions: rest });
      expect(r.achievedLevel).toBe("SPEND");
      expect(r.checks.find((c) => c.check === "deadweight_sourced")).toMatchObject({ passed: false });
    });

    it("respondents without both attribution answers do not count toward the attribution sample", () => {
      const half = [...visitors.slice(0, 199), visitor({ ACCOMMODATION: 100_000 }, { mainReason: null })];
      const r = calculateImpact({ ...input, responses: [...half, ...locals], assumptions: survey });
      expect(r.counts.withAttributionAnswers).toBe(199);
      expect(r.achievedLevel).toBe("SPEND");
    });
  });
});
