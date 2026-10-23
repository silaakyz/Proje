/**
 * Data-sufficiency gate for the three-level impact model.
 *
 * This is NOT the impact calculation (that is V0.3). It decides, before any number is produced,
 * which level a run may report, and records why. The database enforces the same contract
 * (CHECK constraints on analytics.impact_calculation_runs), so a figure for a level that was not
 * achieved cannot be stored, and therefore cannot reach a report.
 *
 * Thresholds come from metric_definitions.min_sample_size, which are UNREVIEWED placeholders until
 * the methodology review confirms them. The gate reports that status alongside each check.
 */
import { z } from "zod";
import { METRIC_LIBRARY } from "@/lib/metrics/library";

export const IMPACT_ENGINE_VERSION = "impact-gate/0.2.0" as const;
export const IMPACT_LEVELS = ["SPEND", "ATTRIBUTABLE_SPEND", "ECONOMIC_IMPACT"] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

const sourced = z.object({
  value: z.number().min(0).max(1),
  /** Where the value comes from: survey estimate, study citation, or a named methodological decision. */
  source: z.string().min(10),
});

/**
 * How the share of visitor spend that is due to the event is found (document §3.10, §4.1–4.2):
 *   SURVEY_STRICT        measured from the attendee survey with the strict rule — non-resident AND main reason =
 *                        the event AND "would not have come otherwise"; applied per spend category. Default.
 *   RECORDED_DEADWEIGHT  a deadweight rate the organization records with its source (1 − rate is attributable).
 */
export const ATTRIBUTION_METHODS = ["SURVEY_STRICT", "RECORDED_DEADWEIGHT"] as const;
export type AttributionMethod = (typeof ATTRIBUTION_METHODS)[number];

/** Every adjustment carries a value AND its source. Missing source = assumption not usable. */
export const impactAssumptionsSchema = z.object({
  attributionMethod: z.enum(ATTRIBUTION_METHODS).default("SURVEY_STRICT"),
  deadweight: sourced.optional(),
  displacement: sourced.optional(),
  leakage: sourced.optional(),
  priceYear: z.number().int().min(2000).max(2100),
});
export type ImpactAssumptions = z.infer<typeof impactAssumptionsSchema>;

export interface SufficiencyInput {
  requestedLevel: ImpactLevel;
  attendance: { basis: "CHECKIN" | "REGISTRATION" | "ORGANIZER_ESTIMATE"; value: number } | null;
  /** Usable, non-excluded attendee responses. */
  responses: { nonResidentWithSpend: number; withAttributionAnswers: number };
  assumptions: unknown;
  eventNuts2Code: string | null;
  multiplierSet: { id: string; nuts2Code: string | null; isActive: boolean; method: string } | null;
}

export interface SufficiencyCheck {
  level: ImpactLevel;
  check: string;
  passed: boolean;
  required?: number | string;
  actual?: number | string | null;
  note?: string;
}

export interface SufficiencyResult {
  engineVersion: typeof IMPACT_ENGINE_VERSION;
  requestedLevel: ImpactLevel;
  achievedLevel: ImpactLevel | null;
  status: "SUCCEEDED" | "INSUFFICIENT_DATA";
  checks: SufficiencyCheck[];
}

const minSample = (key: string) => {
  const m = METRIC_LIBRARY.find((x) => x.key === key);
  if (!m?.minSampleSize) throw new Error(`metric ${key} has no minimum sample size`);
  return m.minSampleSize;
};

export function assessImpactSufficiency(input: SufficiencyInput): SufficiencyResult {
  const checks: SufficiencyCheck[] = [];
  const placeholder = "Eşik değeri metrik kütüphanesindeki henüz incelenmemiş varsayılandır.";
  const parsedAssumptions = impactAssumptionsSchema.safeParse(input.assumptions);
  const a = parsedAssumptions.success ? parsedAssumptions.data : null;

  // ── Level 1: SPEND ────────────────────────────────────────────────────
  const spendMin = minSample("mean_spend_per_visitor_day");
  const l1 = [
    { level: "SPEND" as const, check: "attendance_known", passed: !!input.attendance && input.attendance.value > 0,
      actual: input.attendance ? `${input.attendance.basis}:${input.attendance.value}` : null },
    { level: "SPEND" as const, check: "min_spend_responses", passed: input.responses.nonResidentWithSpend >= spendMin,
      required: spendMin, actual: input.responses.nonResidentWithSpend, note: placeholder },
    { level: "SPEND" as const, check: "assumptions_valid", passed: parsedAssumptions.success,
      note: parsedAssumptions.success ? undefined : "Varsayım kaydı geçersiz (fiyat yılı veya kaynak eksik)." },
  ];
  checks.push(...l1);

  // ── Level 2: ATTRIBUTABLE_SPEND ───────────────────────────────────────
  const attrMin = minSample("attributable_visitor_spend");
  const l2 = [
    { level: "ATTRIBUTABLE_SPEND" as const, check: "attendance_measured",
      passed: !!input.attendance && input.attendance.basis !== "ORGANIZER_ESTIMATE",
      actual: input.attendance?.basis ?? null, note: "Net etki, organizatör tahmini katılımla büyütülemez." },
    { level: "ATTRIBUTABLE_SPEND" as const, check: "min_attribution_responses",
      passed: input.responses.withAttributionAnswers >= attrMin, required: attrMin,
      actual: input.responses.withAttributionAnswers, note: placeholder },
    a?.attributionMethod === "RECORDED_DEADWEIGHT"
      ? { level: "ATTRIBUTABLE_SPEND" as const, check: "deadweight_sourced", passed: !!a.deadweight }
      : { level: "ATTRIBUTABLE_SPEND" as const, check: "attribution_from_survey", passed: !!a,
        note: "Katı kural: şehir dışından, ana geliş nedeni etkinlik ve etkinlik olmasa gelmeyecek ziyaretçinin harcaması." },
    { level: "ATTRIBUTABLE_SPEND" as const, check: "displacement_sourced", passed: !!a?.displacement },
  ];
  checks.push(...l2);

  // ── Level 3: ECONOMIC_IMPACT ──────────────────────────────────────────
  const ms = input.multiplierSet;
  const l3 = [
    { level: "ECONOMIC_IMPACT" as const, check: "multiplier_set_active", passed: !!ms?.isActive, actual: ms?.id ?? null },
    { level: "ECONOMIC_IMPACT" as const, check: "multiplier_set_matches_region",
      passed: !!ms && !!input.eventNuts2Code && ms.nuts2Code === input.eventNuts2Code,
      required: input.eventNuts2Code ?? "event region", actual: ms?.nuts2Code ?? null,
      note: "Ulusal tablo bölgesel etki için kullanılmaz; bölgeselleştirilmiş set gerekir." },
    { level: "ECONOMIC_IMPACT" as const, check: "leakage_sourced", passed: !!a?.leakage },
  ];
  checks.push(...l3);

  const ok = (xs: SufficiencyCheck[]) => xs.every((c) => c.passed);
  const reached: ImpactLevel | null = !ok(l1) ? null : !ok(l2) ? "SPEND" : !ok(l3) ? "ATTRIBUTABLE_SPEND" : "ECONOMIC_IMPACT";
  const cap = IMPACT_LEVELS.indexOf(input.requestedLevel);
  const achievedLevel = reached === null ? null : IMPACT_LEVELS[Math.min(IMPACT_LEVELS.indexOf(reached), cap)]!;

  return {
    engineVersion: IMPACT_ENGINE_VERSION,
    requestedLevel: input.requestedLevel,
    achievedLevel,
    status: achievedLevel === input.requestedLevel ? "SUCCEEDED" : "INSUFFICIENT_DATA",
    // Only report checks up to the requested level.
    checks: checks.filter((c) => IMPACT_LEVELS.indexOf(c.level) <= cap),
  };
}
