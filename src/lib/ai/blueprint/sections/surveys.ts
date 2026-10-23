/**
 * Blueprint section — survey drafts.
 *
 * Each needed audience gets one survey: canonical question-bank items for the chosen KPIs first
 * (fixed keys, scales, spend mappings), then at most MAX_EXTRA contextual questions from the model.
 * Surveys are saved as DRAFT; nothing is sent without the organizer.
 */
import { z } from "zod";
import { toMachineKey } from "@/lib/ai/schemas/event-config";
import type { BlueprintCore } from "@/lib/ai/blueprint/core";
import type { DataRequirements, PlannedKpi } from "@/lib/ai/blueprint/sections/kpis";
import { SURVEY_AUDIENCES, type SurveyAudienceValue } from "@/lib/domain/enums";
import { vocabularyFor } from "@/lib/modules/registry";
import { QUESTION_BANK, SURVEY_QUESTION_TYPES, type SurveyQuestion } from "@/lib/metrics/question-bank";

export const MAX_EXTRA = 8;
export const MAX_QUESTIONS = 25;

/** Audiences that get a survey: those the KPIs need + those the enabled modules call for. */
export function surveyAudiencesFor(core: BlueprintCore, req: DataRequirements): SurveyAudienceValue[] {
  const fromModules = vocabularyFor(core.modules.map((m) => m.key)).surveyAudiences;
  return [...new Set<SurveyAudienceValue>([...req.surveys.map((s) => s.audience), ...fromModules])];
}

export function buildSurveysDraftSchema(audiences: readonly SurveyAudienceValue[]) {
  const aud = z.enum((audiences.length ? audiences : SURVEY_AUDIENCES) as [SurveyAudienceValue, ...SurveyAudienceValue[]]);
  return z.object({
    surveys: z.array(
      z.object({
        audience: aud,
        title: z.string().describe("Turkish survey title."),
        intro: z.string().describe("2 sentences: purpose and approximate duration. Do not promise anonymity or prizes."),
        extraQuestions: z
          .array(
            z.object({
              key: z.string().describe("snake_case"),
              type: z.enum(SURVEY_QUESTION_TYPES),
              text: z.string().describe("Neutral, single-topic Turkish question. No leading or double-barrelled wording."),
              options: z.array(z.object({ value: z.string(), label: z.string() })).nullable().describe("Required for SINGLE_CHOICE / MULTI_CHOICE; else null."),
              required: z.boolean(),
            }),
          )
          .describe(`Up to ${MAX_EXTRA} event-specific questions. The platform already adds the KPI questions; do not duplicate satisfaction, recommendation, residence or spending questions.`),
      }),
    ),
  });
}
export type SurveysDraft = z.infer<ReturnType<typeof buildSurveysDraftSchema>>;

export interface PlannedSurvey {
  key: string; // stable blueprint key: survey_<audience>
  audience: SurveyAudienceValue;
  title: string;
  intro: string;
  questions: SurveyQuestion[];
  targetResponses: number | null;
}

const DEFAULT_TITLE: Record<SurveyAudienceValue, string> = {
  ATTENDEE: "Katılımcı değerlendirme anketi", SPONSOR: "Sponsor değerlendirme anketi", EXHIBITOR: "Katılımcı firma anketi",
  LOCAL_BUSINESS: "Yerel işletme anketi", ORGANIZER: "Ekip değerlendirme anketi", RESIDENT: "Yerel halk görüş anketi",
  PUBLIC_AUTHORITY: "Kamu paydaşları görüş anketi",
};

// Matched at the start of a word of the machine key ("standiniza" must not match "din"; "dini_inanc" must).
const SENSITIVE = /(^|_)(saglik|health|engel|disab|dini?(_|$)|inanc|relig|etnik|ethnic|diyet|diet|alerji|allerg)/;
const CHOICE = new Set(["SINGLE_CHOICE", "MULTI_CHOICE"]);

export function normalizeSurveys(
  draft: SurveysDraft,
  core: BlueprintCore,
  kpis: readonly PlannedKpi[],
  req: DataRequirements,
): { surveys: PlannedSurvey[]; repairs: string[] } {
  const repairs: string[] = [];
  const audiences = surveyAudiencesFor(core, req);
  const out: PlannedSurvey[] = [];

  for (const audience of audiences) {
    const d = draft.surveys.find((s) => s.audience === audience);
    if (!d) repairs.push(`no survey drafted for ${audience}; created from question bank`);

    // 1. bank questions for chosen KPIs, de-duplicated by key, in KPI order
    const questions: SurveyQuestion[] = [];
    const have = new Set<string>();
    for (const k of kpis) {
      const bank = QUESTION_BANK[k.metricKey as keyof typeof QUESTION_BANK];
      if (!bank || bank.audience !== audience) continue;
      for (const q of bank.questions) {
        const existing = questions.find((x) => x.key === q.key);
        if (existing) existing.measures = [...new Set([...existing.measures, ...q.measures])];
        else {
          questions.push({ ...q, measures: [...q.measures] });
          have.add(q.key);
        }
      }
    }

    // 2. model's contextual questions
    const room = Math.max(0, Math.min(MAX_EXTRA, MAX_QUESTIONS - questions.length));
    for (const [i, x] of (d?.extraQuestions ?? []).slice(0, room).entries()) {
      const key = `x_${toMachineKey(x.key || x.text, `q${i + 1}`)}`.slice(0, 48);
      if (have.has(key)) continue;
      const isChoice = CHOICE.has(x.type);
      const options = isChoice && x.options && x.options.length >= 2
        ? x.options.map((o, j) => ({ value: toMachineKey(o.value || o.label, `o${j + 1}`), label: o.label.trim() }))
        : undefined;
      if (isChoice && !options) {
        repairs.push(`survey ${audience}: '${key}' had no options; dropped`);
        continue;
      }
      have.add(key);
      questions.push({
        key, type: x.type, text: x.text.trim(), required: x.required, measures: [], origin: "AI",
        ...(options ? { options } : {}),
        ...(SENSITIVE.test(toMachineKey(x.text, "")) ? { isSensitive: true } : {}),
      });
    }

    // 3. KVKK: explicit consent before any special-category question
    if (questions.some((q) => q.isSensitive)) {
      questions.unshift({
        key: "q_kvkk_special_consent", type: "YES_NO", required: true, measures: [], origin: "SYSTEM",
        text: "Sağlık/erişilebilirlik gibi özel nitelikli bilgilerimin yalnızca etkinlik değerlendirmesi amacıyla işlenmesine açık rıza veriyorum.",
      });
      for (const q of questions) if (q.isSensitive) q.showIf ??= { key: "q_kvkk_special_consent", equals: true };
    }

    if (questions.length === 0) continue;
    const need = req.surveys.find((s) => s.audience === audience)?.minResponses ?? null;
    out.push({
      key: `survey_${audience.toLowerCase()}`,
      audience,
      title: d?.title.trim() || DEFAULT_TITLE[audience],
      intro: d?.intro.trim() || "Bu anket etkinliği değerlendirmek ve sonraki etkinlikleri geliştirmek için hazırlanmıştır.",
      questions,
      targetResponses: need || null,
    });
  }
  return { surveys: out, repairs };
}
