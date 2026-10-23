/**
 * Validates one survey submission against the stored questions of that survey version and extracts
 * what the impact engine reads: the visitor profile (question-bank keys) and spend per category.
 *
 * Rules: unknown keys are rejected; a question hidden by its `showIf` must not be answered; a visible
 * mandatory question must be answered; each answer must fit its question type. Answers to sensitive
 * questions (isSensitive) are accepted only with the respondent's explicit consent flag.
 */
import { SPEND_CATEGORIES, type SpendCategoryValue } from "@/lib/metrics/question-bank";

export interface StoredQuestion {
  questionKey: string | null;
  type: string;
  isMandatory: boolean;
  isSensitive: boolean;
  options: { value: string; label: string }[] | null;
  metadata: Record<string, unknown>;
}

export interface NormalisedResponse {
  answers: Record<string, unknown>;
  isLocalResident: boolean | null;
  homeProvinceCode: number | null;
  partySize: number | null;
  daysPresent: number | null;
  nightsStayed: number | null;
  mainReason: string | null;
  wouldVisitAnyway: string | null;
  /** Kuruş per category (several questions of one category are added up). */
  spendKurus: Partial<Record<SpendCategoryValue, number>>;
}

export class AnswerValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid answers: ${problems.join("; ")}`);
  }
}

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isNum = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** Integer ranges of the profile keys (match the CHECK constraints of survey_responses). */
const INT_KEYS: Record<string, [number, number]> = {
  q_party_size: [1, 500],
  q_days_present: [1, 366],
  q_nights_stayed: [0, 366],
};

function checkType(q: StoredQuestion, v: unknown): string | null {
  const opts = new Set((q.options ?? []).map((o) => o.value));
  switch (q.type) {
    case "LIKERT_5":
    case "rating":
      return isInt(v, 1, 5) ? null : "an integer 1–5";
    case "NPS_0_10":
      return isInt(v, 0, 10) ? null : "an integer 0–10";
    case "YES_NO":
    case "boolean":
      return typeof v === "boolean" ? null : "true or false";
    case "SINGLE_CHOICE":
      return typeof v === "string" && opts.has(v) ? null : "one of the options";
    case "MULTI_CHOICE":
      return Array.isArray(v) && v.length > 0 && new Set(v).size === v.length && v.every((x) => typeof x === "string" && opts.has(x))
        ? null : "a non-empty list of distinct options";
    case "NUMBER": {
      const r = q.questionKey ? INT_KEYS[q.questionKey] : undefined;
      if (r) return isInt(v, r[0], r[1]) ? null : `an integer ${r[0]}–${r[1]}`;
      return isNum(v, 0, 1_000_000) ? null : "a number 0–1,000,000";
    }
    case "PERCENT":
      return isNum(v, -100, 10_000) ? null : "a percentage −100…10,000";
    case "CURRENCY_TRY":
      return isNum(v, 0, 1_000_000_000) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? null : "an amount in TL (≥ 0, max 2 decimals)";
    case "PROVINCE":
      return isInt(v, 0, 81) ? null : "a province plate code 1–81, or 0 for abroad";
    case "OPEN_TEXT":
    case "text":
      return typeof v === "string" && v.trim().length > 0 && v.length <= 2000 ? null : "text of 1–2,000 characters";
    default:
      return `a supported question type (got ${q.type})`;
  }
}

const isVisible = (q: StoredQuestion, answers: Record<string, unknown>) => {
  const showIf = q.metadata.showIf as { key: string; equals: string | boolean } | undefined;
  return !showIf || answers[showIf.key] === showIf.equals;
};

export function normaliseAnswers(
  questions: readonly StoredQuestion[],
  raw: Record<string, unknown>,
  opts: { sensitiveConsent: boolean },
): NormalisedResponse {
  const problems: string[] = [];
  const byKey = new Map(questions.filter((q) => q.questionKey).map((q) => [q.questionKey!, q]));
  const answers: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === "") continue; // unanswered
    const q = byKey.get(k);
    if (!q) { problems.push(`${k}: not a question of this survey`); continue; }
    const want = checkType(q, v);
    if (want) { problems.push(`${k}: must be ${want}`); continue; }
    answers[k] = typeof v === "string" ? v.trim() : v;
  }
  for (const q of byKey.values()) {
    const k = q.questionKey!;
    const visible = isVisible(q, answers);
    if (!visible && k in answers) problems.push(`${k}: not asked for the given answers (showIf)`);
    if (visible && q.isMandatory && !(k in answers)) problems.push(`${k}: required`);
    if (q.isSensitive && k in answers && !opts.sensitiveConsent) problems.push(`${k}: sensitive answer without consent`);
  }
  if (problems.length) throw new AnswerValidationError(problems);

  const spendKurus: Partial<Record<SpendCategoryValue, number>> = {};
  for (const q of byKey.values()) {
    const cat = q.metadata.spendCategory as SpendCategoryValue | undefined;
    const v = answers[q.questionKey!];
    if (q.type !== "CURRENCY_TRY" || !cat || typeof v !== "number") continue;
    if (!(SPEND_CATEGORIES as readonly string[]).includes(cat)) continue;
    spendKurus[cat] = (spendKurus[cat] ?? 0) + Math.round(v * 100);
  }
  const pick = <T>(k: string) => (k in answers ? (answers[k] as T) : null);
  /** Profile columns take only the question bank's values; anything else stays in `answers` only. */
  const oneOf = (v: string | null, allowed: string[]) => (v !== null && allowed.includes(v) ? v : null);
  return {
    answers,
    isLocalResident: pick<boolean>("q_is_local"),
    homeProvinceCode: pick<number>("q_home_province"),
    partySize: pick<number>("q_party_size"),
    daysPresent: pick<number>("q_days_present"),
    nightsStayed: pick<number>("q_nights_stayed"),
    mainReason: oneOf(pick<string>("q_main_reason"), ["event", "event_and_other", "other"]),
    wouldVisitAnyway: oneOf(pick<string>("q_would_visit_anyway"), ["yes", "maybe", "no"]),
    spendKurus,
  };
}
