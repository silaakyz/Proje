/**
 * Impact calculation engine (pure, deterministic). Runs the data-sufficiency gate first and computes
 * figures only for the levels the data reached.
 *
 * The arithmetic is the one the metric library already defines (src/lib/metrics/library.ts):
 *  - visitor_share               weighted share of respondents who do not live in the event's province
 *                                (q_is_local = false)
 *  - mean_spend_per_visitor_day  Σ w·(spend ÷ party_size) ÷ Σ w·days_present, non-residents, per-person
 *                                spend trimmed at the 1st/99th percentile (nearest rank)
 *  - gross non-resident spend    attendance × visitor_share × mean days present × mean spend per visitor-day
 *  - attributable_visitor_spend  per spend category (document §3.10; UK guidance: additionality per spending item):
 *                                SURVEY_STRICT (default): gross_c × strict share_c × (1 − displacement), where
 *                                strict share_c = Σ w·spend_c·1[strict] ÷ Σ w·spend_c over the trimmed non-resident
 *                                spenders who answered both attribution questions; strict = main reason "event" AND
 *                                would-visit-anyway "no" (no partial credit, document §4.1). A category nobody in
 *                                that group spent on takes the overall strict share.
 *                                RECORDED_DEADWEIGHT: gross × (1 − deadweight) × (1 − displacement).
 *                                Sensitivity (breakdown only, never the headline): the broad rule — main reason
 *                                "event" or "event and other" AND would-visit-anyway "no" or "maybe".
 *  - economic impact (level 3)   per spend category: attributable × (1 − leakage) = first-round local demand,
 *                                × the category's output / value-added / income multiplier; employment =
 *                                demand ÷ 1,000,000 × jobs per million TRY.
 *
 * No coefficient lives in code: deadweight, displacement, leakage and every multiplier are the
 * organization's recorded inputs, each with its source. Weights are 1 until weighting rules exist.
 * Price years: output, value-added and income multipliers are ratios per TRY of demand and are applied to
 * spend of any price year (the input-output model's fixed technical coefficients — e.g. a TÜİK 2023 set on
 * 2026 spend). Employment per million TRY depends on the price level, so it is reported only when the set's
 * price year equals the assumptions' price year; otherwise the employment figure is left out (no deflation).
 * Not included: confidence intervals, inflation adjustment, sector splitting of a category across several
 * A-64 sectors (TÜİK sets do this in src/lib/io), retail margin handling (likewise).
 */
import { assessImpactSufficiency, impactAssumptionsSchema, IMPACT_LEVELS, type ImpactLevel, type SufficiencyCheck,
  type SufficiencyInput } from "@/lib/impact/sufficiency";
import { SPEND_CATEGORIES, type SpendCategoryValue } from "@/lib/metrics/question-bank";

export const IMPACT_CALC_VERSION = "impact-engine/2.0.0" as const;

export interface EngineResponse {
  weight: number;
  isLocalResident: boolean | null;
  partySize: number | null;
  daysPresent: number | null;
  wouldVisitAnyway: string | null;
  /** q_main_reason: event | event_and_other | other. */
  mainReason: string | null;
  /** Spend for the party's whole stay, in kuruş, per answered category. */
  spendKurus: Partial<Record<SpendCategoryValue, number>>;
}

export interface EngineMultiplier {
  spendCategory: SpendCategoryValue;
  output: number;
  valueAdded: number;
  income: number;
  /** Null when the set has no employment coefficient (e.g. derived from TÜİK I-O tables): no employment figure. */
  employmentPerMTry: number | null;
}

export interface EngineInput {
  requestedLevel: ImpactLevel;
  attendance: SufficiencyInput["attendance"];
  responses: readonly EngineResponse[];
  assumptions: unknown;
  eventNuts2Code: string | null;
  multiplierSet: {
    id: string; nuts2Code: string | null; isActive: boolean; method: string; priceYear: number; coefficients: readonly EngineMultiplier[];
  } | null;
}

export interface CategoryFigures {
  gross: number;
  attributable?: number;
  localDemand?: number;
  output?: number;
  valueAdded?: number;
  income?: number;
  employmentFte?: number;
}

export interface EngineResult {
  engineVersion: typeof IMPACT_CALC_VERSION;
  requestedLevel: ImpactLevel;
  achievedLevel: ImpactLevel | null;
  status: "SUCCEEDED" | "INSUFFICIENT_DATA";
  checks: SufficiencyCheck[];
  counts: { usableResponses: number; profileAnswered: number; nonResidentWithSpend: number; withAttributionAnswers: number };
  /** Null when not even level 1 was reached. Each figure is present only when its level was reached. */
  figures: null | {
    grossDirectSpend: number;
    attributableSpend?: number;
    totalOutputImpact?: number;
    totalValueAdded?: number;
    totalIncome?: number;
    totalEmploymentFte?: number;
  };
  breakdown: null | {
    visitorShare: number;
    nonResidentVisitors: number;
    meanDaysPresent: number;
    meanSpendPerVisitorDay: number;
    spendSample: number;
    trimmedOut: number;
    byCategory: Partial<Record<SpendCategoryValue, CategoryFigures>>;
    /** How attributable spend was found (present from level 2). */
    attribution?: AttributionBreakdown;
  };
}

export type AttributionBreakdown =
  | { method: "RECORDED_DEADWEIGHT"; deadweight: number; displacement: number }
  | {
    method: "SURVEY_STRICT";
    displacement: number;
    /** Trimmed non-resident spenders who answered both attribution questions. */
    respondents: number;
    strictRespondentShare: number;
    strictSpendShare: number;
    shareByCategory: Partial<Record<SpendCategoryValue, number>>;
    /** Broad rule, for the sensitivity statement only. */
    sensitivity: { rule: "BROAD"; spendShare: number; attributableSpend: number; totalOutputImpact?: number };
  };

const strictRule = (r: EngineResponse) => r.mainReason === "event" && r.wouldVisitAnyway === "no";
const broadRule = (r: EngineResponse) =>
  (r.mainReason === "event" || r.mainReason === "event_and_other") && (r.wouldVisitAnyway === "no" || r.wouldVisitAnyway === "maybe");
const answeredAttribution = (r: EngineResponse) => r.mainReason !== null && r.wouldVisitAnyway !== null;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const rank = (l: ImpactLevel | null) => (l === null ? -1 : IMPACT_LEVELS.indexOf(l));

const isUsableSpender = (r: EngineResponse) =>
  r.isLocalResident === false && (r.partySize ?? 0) >= 1 && (r.daysPresent ?? 0) >= 1 && Object.keys(r.spendKurus).length > 0;

export function responseCounts(responses: readonly EngineResponse[]) {
  const profile = responses.filter((r) => r.isLocalResident !== null);
  return {
    usableResponses: responses.length,
    profileAnswered: profile.length,
    nonResidentWithSpend: responses.filter(isUsableSpender).length,
    withAttributionAnswers: responses.filter((r) => r.isLocalResident === false && answeredAttribution(r)).length,
  };
}

/** Nearest-rank percentile of an ascending array. */
const percentile = (sorted: readonly number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

export function calculateImpact(input: EngineInput): EngineResult {
  const counts = responseCounts(input.responses);
  const ms = input.multiplierSet;
  const gate = assessImpactSufficiency({
    requestedLevel: input.requestedLevel,
    attendance: input.attendance,
    responses: { nonResidentWithSpend: counts.nonResidentWithSpend, withAttributionAnswers: counts.withAttributionAnswers },
    assumptions: input.assumptions,
    eventNuts2Code: input.eventNuts2Code,
    multiplierSet: ms ? { id: ms.id, nuts2Code: ms.nuts2Code, isActive: ms.isActive, method: ms.method } : null,
  });
  const checks = [...gate.checks];
  let achieved = gate.achievedLevel;

  const spenders = input.responses.filter(isUsableSpender);
  const spentCategories = SPEND_CATEGORIES.filter((c) => spenders.some((r) => (r.spendKurus[c] ?? 0) > 0));

  // Level-3 condition the gate does not know about: coefficients for every category with spend. The price
  // year only matters for employment (see the header): a differing year drops that figure, not the level.
  if (input.requestedLevel === "ECONOMIC_IMPACT") {
    const parsed = impactAssumptionsSchema.safeParse(input.assumptions);
    const covered = new Set(ms?.coefficients.map((c) => c.spendCategory) ?? []);
    const missing = spentCategories.filter((c) => !covered.has(c));
    const extra: SufficiencyCheck[] = [
      { level: "ECONOMIC_IMPACT", check: "multipliers_cover_spend_categories", passed: !!ms && missing.length === 0,
        required: spentCategories.join(",") || "-", actual: ms ? [...covered].join(",") || "-" : null,
        note: missing.length ? `Çarpanı olmayan harcama kategorileri: ${missing.join(", ")}` : undefined },
    ];
    checks.push(...extra);
    if (achieved === "ECONOMIC_IMPACT" && extra.some((c) => !c.passed)) achieved = "ATTRIBUTABLE_SPEND";
    // Informational, never blocking: shown only when the set has employment coefficients to apply.
    if (ms && spentCategories.length && spentCategories.every((c) => ms.coefficients.find((m) => m.spendCategory === c)?.employmentPerMTry != null)) {
      const same = parsed.success && ms.priceYear === parsed.data.priceYear;
      checks.push({ level: "ECONOMIC_IMPACT", check: "price_years_match", passed: same,
        required: parsed.success ? parsed.data.priceYear : "assumptions.priceYear", actual: ms.priceYear,
        note: same ? undefined : "Fiyat yılları farklı: istihdam (1 mn ₺ başına) hesaplanmadı. Çıktı, katma değer ve gelir çarpanları 1 ₺ başına oran olduğundan kullanıldı." });
    }
  }
  const status = achieved === input.requestedLevel ? "SUCCEEDED" : "INSUFFICIENT_DATA";
  const base = { engineVersion: IMPACT_CALC_VERSION, requestedLevel: input.requestedLevel, achievedLevel: achieved, status, checks, counts } as const;
  if (achieved === null || !input.attendance) return { ...base, figures: null, breakdown: null };

  // ── Level 1: gross non-resident spend ────────────────────────────────
  const profile = input.responses.filter((r) => r.isLocalResident !== null);
  const wAll = profile.reduce((s, r) => s + r.weight, 0);
  const wNonRes = profile.filter((r) => r.isLocalResident === false).reduce((s, r) => s + r.weight, 0);
  const visitorShare = wNonRes / wAll;

  const totalTl = (r: EngineResponse) => Object.values(r.spendKurus).reduce((s, v) => s + (v ?? 0), 0) / 100;
  const perPerson = (r: EngineResponse) => totalTl(r) / r.partySize!;
  const sorted = spenders.map(perPerson).sort((a, b) => a - b);
  const lo = percentile(sorted, 0.01);
  const hi = percentile(sorted, 0.99);
  const kept = spenders.filter((r) => perPerson(r) >= lo && perPerson(r) <= hi);

  const sumW = kept.reduce((s, r) => s + r.weight, 0);
  const sumWDays = kept.reduce((s, r) => s + r.weight * r.daysPresent!, 0);
  const sumWPerPerson = kept.reduce((s, r) => s + r.weight * perPerson(r), 0);
  const meanSpendPerVisitorDay = sumWPerPerson / sumWDays;
  const meanDaysPresent = sumWDays / sumW;
  const nonResidentVisitors = input.attendance.value * visitorShare;
  const grossDirectSpend = nonResidentVisitors * meanDaysPresent * meanSpendPerVisitorDay;

  // Category shares of per-person spend (same trimmed, weighted sample).
  const byCategory: Partial<Record<SpendCategoryValue, CategoryFigures>> = {};
  for (const c of SPEND_CATEGORIES) {
    const part = kept.reduce((s, r) => s + (r.weight * (r.spendKurus[c] ?? 0)) / 100 / r.partySize!, 0);
    if (part > 0) byCategory[c] = { gross: sumWPerPerson > 0 ? (grossDirectSpend * part) / sumWPerPerson : 0 };
  }

  const figures: NonNullable<EngineResult["figures"]> = { grossDirectSpend: round(grossDirectSpend) };

  // ── Level 2: attributable spend ──────────────────────────────────────
  const a = impactAssumptionsSchema.parse(input.assumptions); // the gate passed level 1, so this is valid
  let attribution: AttributionBreakdown | undefined;
  const broadByCategory: Partial<Record<SpendCategoryValue, number>> = {};
  if (rank(achieved) >= rank("ATTRIBUTABLE_SPEND")) {
    const keepDisp = 1 - a.displacement!.value;
    if (a.attributionMethod === "RECORDED_DEADWEIGHT") {
      const factor = (1 - a.deadweight!.value) * keepDisp;
      figures.attributableSpend = round(grossDirectSpend * factor);
      for (const f of Object.values(byCategory)) f!.attributable = round(f!.gross * factor);
      attribution = { method: "RECORDED_DEADWEIGHT", deadweight: a.deadweight!.value, displacement: a.displacement!.value };
    } else {
      const answered = kept.filter(answeredAttribution);
      const spendOf = (r: EngineResponse, c?: SpendCategoryValue) =>
        (r.weight * (c ? (r.spendKurus[c] ?? 0) : Object.values(r.spendKurus).reduce((x, v) => x + (v ?? 0), 0))) / 100 / r.partySize!;
      const share = (rule: (r: EngineResponse) => boolean, c?: SpendCategoryValue) => {
        const den = answered.reduce((x, r) => x + spendOf(r, c), 0);
        return den > 0 ? answered.reduce((x, r) => x + (rule(r) ? spendOf(r, c) : 0), 0) / den : null;
      };
      const strictAll = share(strictRule) ?? 0;
      const broadAll = share(broadRule) ?? 0;
      const shareByCategory: Partial<Record<SpendCategoryValue, number>> = {};
      let total = 0, broadTotal = 0;
      for (const [c, f] of Object.entries(byCategory) as [SpendCategoryValue, CategoryFigures][]) {
        const sc = share(strictRule, c) ?? strictAll;
        const bc = share(broadRule, c) ?? broadAll;
        shareByCategory[c] = round(sc, 6);
        f.attributable = round(f.gross * sc * keepDisp);
        broadByCategory[c] = f.gross * bc * keepDisp;
        total += f.gross * sc * keepDisp;
        broadTotal += f.gross * bc * keepDisp;
      }
      figures.attributableSpend = round(total);
      const wAns = answered.reduce((x, r) => x + r.weight, 0);
      attribution = {
        method: "SURVEY_STRICT", displacement: a.displacement!.value, respondents: answered.length,
        strictRespondentShare: round(wAns > 0 ? answered.reduce((x, r) => x + (strictRule(r) ? r.weight : 0), 0) / wAns : 0, 6),
        strictSpendShare: round(strictAll, 6), shareByCategory,
        sensitivity: { rule: "BROAD", spendShare: round(broadAll, 6), attributableSpend: round(broadTotal) },
      };
    }
  }

  // ── Level 3: economic impact ─────────────────────────────────────────
  if (achieved === "ECONOMIC_IMPACT" && ms) {
    const coef = new Map(ms.coefficients.map((c) => [c.spendCategory, c]));
    let output = 0, valueAdded = 0, income = 0, fte = 0;
    const sameYear = ms.priceYear === a.priceYear;
    const withEmployment = sameYear && Object.keys(byCategory).every((c) => coef.get(c as SpendCategoryValue)?.employmentPerMTry != null);
    for (const [c, f] of Object.entries(byCategory) as [SpendCategoryValue, CategoryFigures][]) {
      const m = coef.get(c)!;
      const localDemand = f.attributable! * (1 - a.leakage!.value);
      f.localDemand = round(localDemand);
      f.output = round(localDemand * m.output);
      f.valueAdded = round(localDemand * m.valueAdded);
      f.income = round(localDemand * m.income);
      if (sameYear && m.employmentPerMTry !== null) f.employmentFte = round((localDemand / 1_000_000) * m.employmentPerMTry);
      output += localDemand * m.output;
      valueAdded += localDemand * m.valueAdded;
      income += localDemand * m.income;
      fte += (localDemand / 1_000_000) * (m.employmentPerMTry ?? 0);
    }
    if (attribution?.method === "SURVEY_STRICT") {
      const broadOutput = (Object.entries(broadByCategory) as [SpendCategoryValue, number][])
        .reduce((x, [c, v]) => x + v * (1 - a.leakage!.value) * coef.get(c)!.output, 0);
      attribution.sensitivity.totalOutputImpact = round(broadOutput);
    }
    Object.assign(figures, { totalOutputImpact: round(output), totalValueAdded: round(valueAdded), totalIncome: round(income), ...(withEmployment ? { totalEmploymentFte: round(fte) } : {}) });
  }
  for (const f of Object.values(byCategory)) f!.gross = round(f!.gross);

  return {
    ...base,
    figures,
    breakdown: {
      visitorShare: round(visitorShare, 6),
      nonResidentVisitors: round(nonResidentVisitors),
      meanDaysPresent: round(meanDaysPresent, 4),
      meanSpendPerVisitorDay: round(meanSpendPerVisitorDay),
      spendSample: kept.length,
      trimmedOut: spenders.length - kept.length,
      byCategory,
      ...(attribution ? { attribution } : {}),
    },
  };
}
