/**
 * Canonical survey questions that make each survey-based KPI computable.
 *
 * The LLM never writes these: if a KPI is selected, its questions are injected verbatim with fixed
 * keys, scales and spend-category mappings, so the KPI engine and impact pipeline can read answers
 * without guessing. The LLM may only add contextual questions next to them.
 */
import { z } from "zod";
import type { SurveyAudienceValue } from "@/lib/domain/enums";
import type { MetricKey } from "@/lib/metrics/library";

export const SURVEY_QUESTION_TYPES = [
  "LIKERT_5", "NPS_0_10", "YES_NO", "SINGLE_CHOICE", "MULTI_CHOICE", "NUMBER", "PERCENT", "CURRENCY_TRY", "PROVINCE", "OPEN_TEXT",
] as const;
export type SurveyQuestionType = (typeof SURVEY_QUESTION_TYPES)[number];

/** Survey spend categories; the database enum `spend_category` (0007) is generated from this list. */
export const SPEND_CATEGORIES = [
  "ACCOMMODATION", "FOOD_BEVERAGE", "LOCAL_TRANSPORT", "INTERCITY_TRANSPORT", "RETAIL_SHOPPING",
  "ENTERTAINMENT_CULTURE", "VENUE_AND_SERVICES", "MARKETING_PRINTING", "OTHER",
] as const;
export type SpendCategoryValue = (typeof SPEND_CATEGORIES)[number];

export const surveyQuestionSchema = z.object({
  key: z.string().regex(/^(q|x)_[a-z0-9_]{1,46}$/),
  type: z.enum(SURVEY_QUESTION_TYPES),
  text: z.string().min(3).max(400),
  helpText: z.string().max(400).optional(),
  options: z.array(z.object({ value: z.string().min(1).max(48), label: z.string().min(1).max(120) })).min(2).max(30).optional(),
  required: z.boolean(),
  measures: z.array(z.string()),
  spendCategory: z.enum(SPEND_CATEGORIES).optional(),
  spendBasis: z.literal("party_total_stay").optional(),
  reverseCoded: z.boolean().optional(),
  isSensitive: z.boolean().optional(),
  showIf: z.object({ key: z.string(), equals: z.union([z.string(), z.boolean()]) }).optional(),
  origin: z.enum(["BANK", "AI", "SYSTEM"]),
}).refine((q) => !["SINGLE_CHOICE", "MULTI_CHOICE"].includes(q.type) || (q.options?.length ?? 0) >= 2, "choice question needs options");

export interface SurveyQuestion {
  key: string;
  type: SurveyQuestionType;
  text: string;
  helpText?: string;
  options?: { value: string; label: string }[];
  required: boolean;
  /** Metrics this answer feeds. */
  measures: string[];
  spendCategory?: SpendCategoryValue;
  /** Spend is reported for the whole party for the whole stay; the pipeline divides by party size. */
  spendBasis?: "party_total_stay";
  reverseCoded?: boolean;
  isSensitive?: boolean;
  showIf?: { key: string; equals: string | boolean };
  origin: "BANK" | "AI" | "SYSTEM";
}

const likert = (key: string, text: string, measures: string[], extra: Partial<SurveyQuestion> = {}): SurveyQuestion => ({
  key, type: "LIKERT_5", text, required: true, measures, origin: "BANK", ...extra,
});
const spend = (key: string, category: SpendCategoryValue, text: string): SurveyQuestion => ({
  key, type: "CURRENCY_TRY", text, required: false, measures: ["mean_spend_per_visitor_day", "attributable_visitor_spend"],
  spendCategory: category, spendBasis: "party_total_stay", origin: "BANK",
  helpText: "Siz ve birlikte geldiğiniz grubun bu şehirde toplam harcaması (TL). Harcama yoksa 0 yazın.",
  showIf: { key: "q_is_local", equals: false },
});

const VISITOR_PROFILE: SurveyQuestion[] = [
  { key: "q_home_province", type: "PROVINCE", text: "Hangi ilde ikamet ediyorsunuz?", required: true,
    measures: ["visitor_share", "mean_spend_per_visitor_day", "attributable_visitor_spend"], origin: "BANK",
    helpText: "Yurt dışında yaşıyorsanız 'Yurt dışı' seçin." },
  { key: "q_is_local", type: "YES_NO", text: "Etkinliğin yapıldığı ilde mi yaşıyorsunuz?", required: true,
    measures: ["visitor_share"], origin: "BANK" },
  { key: "q_party_size", type: "NUMBER", text: "Kendiniz dahil kaç kişilik bir grupla geldiniz?", required: true,
    measures: ["mean_spend_per_visitor_day"], origin: "BANK", showIf: { key: "q_is_local", equals: false } },
  { key: "q_days_present", type: "NUMBER", text: "Etkinliğin kaç gününe katıldınız / katılacaksınız?", required: true,
    measures: ["mean_spend_per_visitor_day", "unique_visitors_estimated"], origin: "BANK" },
];

const SPEND_BLOCK: SurveyQuestion[] = [
  spend("q_spend_accommodation", "ACCOMMODATION", "Konaklama harcaması"),
  spend("q_spend_food", "FOOD_BEVERAGE", "Yeme-içme harcaması"),
  spend("q_spend_local_transport", "LOCAL_TRANSPORT", "Şehir içi ulaşım (taksi, toplu taşıma, yakıt)"),
  spend("q_spend_shopping", "RETAIL_SHOPPING", "Alışveriş harcaması"),
  spend("q_spend_culture", "ENTERTAINMENT_CULTURE", "Etkinlik dışı eğlence ve kültür harcaması"),
  spend("q_spend_other", "OTHER", "Diğer harcamalar"),
];

export const QUESTION_BANK: Partial<Record<MetricKey, { audience: SurveyAudienceValue; questions: SurveyQuestion[] }>> = {
  overall_satisfaction: {
    audience: "ATTENDEE",
    questions: [likert("q_overall_satisfaction", "Etkinlikten genel olarak ne kadar memnun kaldınız?", ["overall_satisfaction"])],
  },
  nps: {
    audience: "ATTENDEE",
    questions: [{ key: "q_nps", type: "NPS_0_10", required: true, measures: ["nps"], origin: "BANK",
      text: "Bu etkinliği bir arkadaşınıza veya meslektaşınıza tavsiye etme olasılığınız nedir? (0 = hiç, 10 = kesinlikle)" }],
  },
  repeat_attendance_rate: {
    audience: "ATTENDEE",
    questions: [{ key: "q_attended_before", type: "YES_NO", required: true, measures: ["repeat_attendance_rate"], origin: "BANK",
      text: "Bu etkinliğin önceki bir edisyonuna katıldınız mı?" }],
  },
  visitor_share: { audience: "ATTENDEE", questions: VISITOR_PROFILE.slice(0, 2) },
  // Survey half of the estimate (mean visits per person); gate counts come from site operations.
  unique_visitors_estimated: { audience: "ATTENDEE", questions: [VISITOR_PROFILE[3]!] },
  mean_nights_stayed: {
    audience: "ATTENDEE",
    questions: [...VISITOR_PROFILE.slice(0, 2), { key: "q_nights_stayed", type: "NUMBER", required: true,
      measures: ["mean_nights_stayed"], origin: "BANK", showIf: { key: "q_is_local", equals: false },
      text: "Etkinlik nedeniyle bu şehirde kaç gece konakladınız / konaklayacaksınız?" }],
  },
  mean_spend_per_visitor_day: { audience: "ATTENDEE", questions: [...VISITOR_PROFILE, ...SPEND_BLOCK] },
  attributable_visitor_spend: {
    audience: "ATTENDEE",
    questions: [
      ...VISITOR_PROFILE,
      ...SPEND_BLOCK,
      { key: "q_main_reason", type: "SINGLE_CHOICE", required: true, measures: ["attributable_visitor_spend"], origin: "BANK",
        showIf: { key: "q_is_local", equals: false },
        text: "Bu şehre gelmenizin ana nedeni neydi?",
        options: [
          { value: "event", label: "Bu etkinlik" },
          { value: "event_and_other", label: "Etkinlik ve başka nedenler birlikte" },
          { value: "other", label: "Başka bir neden (iş, akraba ziyareti vb.); etkinliğe denk geldim" },
        ] },
      { key: "q_would_visit_anyway", type: "SINGLE_CHOICE", required: true, measures: ["attributable_visitor_spend"], origin: "BANK",
        showIf: { key: "q_is_local", equals: false },
        text: "Etkinlik olmasaydı bu tarihlerde yine de bu şehre gelir miydiniz?",
        options: [
          { value: "yes", label: "Evet" },
          { value: "maybe", label: "Belki" },
          { value: "no", label: "Hayır" },
        ] },
    ],
  },
  complaint_theme_share: {
    audience: "ATTENDEE",
    questions: [{ key: "q_improve", type: "OPEN_TEXT", required: false, measures: ["complaint_theme_share"], origin: "BANK",
      text: "Etkinliği geliştirmek için önerileriniz veya yaşadığınız sorunlar nelerdir?" }],
  },
  accessibility_satisfaction: {
    audience: "ATTENDEE",
    questions: [
      { key: "q_access_need", type: "YES_NO", required: false, measures: ["accessibility_satisfaction"], origin: "BANK", isSensitive: true,
        text: "Etkinlik alanında erişilebilirlik ihtiyacınız (hareket, görme, işitme vb.) var mıydı?" },
      likert("q_accessibility", "Erişilebilirlik ihtiyaçlarınızın karşılanmasından ne kadar memnun kaldınız?", ["accessibility_satisfaction"],
        { showIf: { key: "q_access_need", equals: true }, required: false }),
    ],
  },
  local_business_turnover_change: {
    audience: "LOCAL_BUSINESS",
    questions: [
      { key: "q_business_sector", type: "SINGLE_CHOICE", required: true, measures: ["local_business_turnover_change"], origin: "BANK",
        text: "İşletmenizin faaliyet alanı nedir?",
        options: [
          { value: "food_beverage", label: "Yeme-içme" },
          { value: "accommodation", label: "Konaklama" },
          { value: "retail", label: "Perakende" },
          { value: "transport", label: "Ulaşım" },
          { value: "services", label: "Hizmet" },
          { value: "other", label: "Diğer" },
        ] },
      { key: "q_turnover_change", type: "PERCENT", required: true, measures: ["local_business_turnover_change"], origin: "BANK",
        text: "Etkinlik günlerinde cironuz, benzer bir normal güne göre yaklaşık yüzde kaç değişti? (Azaldıysa eksi değer girin.)" },
    ],
  },
  resident_support_index: {
    audience: "RESIDENT",
    questions: [
      likert("q_res_city_image", "Bu etkinlik şehrin tanınırlığına katkı sağlıyor.", ["resident_support_index"]),
      likert("q_res_local_economy", "Bu etkinlik yerel ekonomiye fayda sağlıyor.", ["resident_support_index"]),
      likert("q_res_daily_life", "Bu etkinlik günlük yaşamımı olumsuz etkiledi (trafik, gürültü vb.).", ["resident_support_index"], { reverseCoded: true }),
      likert("q_res_support", "Bu etkinliğin önümüzdeki yıllarda da yapılmasını destekliyorum.", ["resident_support_index"]),
    ],
  },
  sponsor_renewal_intent: {
    audience: "SPONSOR",
    questions: [{ key: "q_sponsor_renewal", type: "SINGLE_CHOICE", required: true, measures: ["sponsor_renewal_intent"], origin: "BANK",
      text: "Bir sonraki edisyonda sponsor olmayı ne kadar olası görüyorsunuz?",
      options: [
        { value: "very_likely", label: "Çok olası" },
        { value: "likely", label: "Olası" },
        { value: "unsure", label: "Kararsızım" },
        { value: "unlikely", label: "Olası değil" },
        { value: "very_unlikely", label: "Hiç olası değil" },
      ] }],
  },
  leads_per_exhibitor: {
    audience: "EXHIBITOR",
    questions: [{ key: "q_leads", type: "NUMBER", required: true, measures: ["leads_per_exhibitor"], origin: "BANK",
      text: "Etkinlik süresince kaç potansiyel müşteriyle iletişim bilgisi paylaştınız?" }],
  },
};
