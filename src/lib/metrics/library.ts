/**
 * Initial Metric Evidence Registry (seeded into analytics.metric_definitions).
 *
 * Definitions and formulas are operational, so the KPI engine can compute them. Every entry starts
 * as evidenceStatus "UNREVIEWED" with an empty `evidence` list: citations come from the literature
 * review, never from an LLM. `minSampleSize` values are conservative placeholders to be confirmed
 * in that review; below them the dashboard shows "yetersiz veri" instead of a number.
 */
import type { EventFormatValue, MetricCategoryValue, MetricDataSourceValue } from "@/lib/domain/enums";
import type { ModuleKey } from "@/lib/modules/registry";

export interface MetricSeed {
  key: string;
  name: string;
  nameEn: string;
  description: string;
  category: MetricCategoryValue;
  unit: string;
  formula: string;
  dataSources: MetricDataSourceValue[];
  eventFormats: EventFormatValue[]; // empty = all
  requiresModule: ModuleKey | null;
  minSampleSize: number | null;
  higherIsBetter: boolean | null;
  /**
   * For SURVEY-sourced metrics whose answers are NOT collected by the question bank (e.g. per-session
   * ratings), the module whose own feedback flow collects them. Validation requires one or the other.
   */
  surveyInputsCollectedBy?: ModuleKey;
  /**
   * Groups of interchangeable sources ("any one of"), taken from the formula. Sources not in a group
   * are all required. Absent = every listed source is required.
   */
  anyOf?: MetricDataSourceValue[][];
}

export const METRIC_LIBRARY = [
  // ── Attendance ──────────────────────────────────────────────────────────
  {
    key: "registrations_confirmed", name: "Onaylı kayıt sayısı", nameEn: "Confirmed registrations",
    description: "İptal edilmemiş, onaylanmış kayıtların sayısı.",
    category: "ATTENDANCE", unit: "kişi", formula: "count(attendees where status = CONFIRMED)",
    dataSources: ["REGISTRATION"], eventFormats: [], requiresModule: "registration", minSampleSize: null, higherIsBetter: true,
  },
  {
    key: "show_up_rate", name: "Katılım oranı", nameEn: "Show-up rate",
    description: "Kayıt olanların en az bir gün giriş yapan kısmı.",
    category: "ATTENDANCE", unit: "%", formula: "distinct attendees with ≥1 ACCEPTED check-in ÷ confirmed registrations × 100",
    dataSources: ["REGISTRATION", "CHECKIN"], eventFormats: [], requiresModule: "registration", minSampleSize: 30, higherIsBetter: true,
  },
  {
    key: "unique_visitors_estimated", name: "Tahmini tekil ziyaretçi", nameEn: "Estimated unique visitors",
    description: "Açık alan etkinliklerinde sayım verisinden tekrar ziyaret düzeltmesiyle tahmin edilen tekil kişi sayısı.",
    category: "ATTENDANCE", unit: "kişi", formula: "Σ gate entries ÷ mean visits per person (from attendee survey)",
    dataSources: ["MANUAL_ENTRY", "EXTERNAL_API", "SURVEY"], eventFormats: [], requiresModule: "site_operations", minSampleSize: 100, higherIsBetter: true,
    anyOf: [["MANUAL_ENTRY", "EXTERNAL_API"]],
  },
  {
    key: "peak_occupancy_ratio", name: "En yüksek doluluk oranı", nameEn: "Peak occupancy ratio",
    description: "Herhangi bir anda alandaki kişi sayısının güvenli kapasiteye oranı.",
    category: "OPERATIONS", unit: "%", formula: "max over time(entries − exits) ÷ safe capacity × 100",
    dataSources: ["CHECKIN", "MANUAL_ENTRY", "EXTERNAL_API"], eventFormats: [], requiresModule: "site_operations", minSampleSize: null, higherIsBetter: null,
    anyOf: [["CHECKIN", "MANUAL_ENTRY", "EXTERNAL_API"]],
  },
  {
    key: "repeat_attendance_rate", name: "Tekrar katılım oranı", nameEn: "Repeat attendance rate",
    description: "Önceki edisyona da katılmış olanların oranı.",
    category: "ATTENDANCE", unit: "%", formula: "respondents who attended a previous edition ÷ respondents × 100 (weighted)",
    dataSources: ["SURVEY", "REGISTRATION"], eventFormats: [], requiresModule: null, minSampleSize: 100, higherIsBetter: true,
    anyOf: [["SURVEY", "REGISTRATION"]],
  },
  // ── Experience ──────────────────────────────────────────────────────────
  {
    key: "overall_satisfaction", name: "Genel memnuniyet", nameEn: "Overall satisfaction",
    description: "Katılımcıların 1–5 ölçeğinde genel memnuniyet ortalaması.",
    category: "EXPERIENCE", unit: "puan (1–5)", formula: "weighted mean of Q_overall_satisfaction",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: null, minSampleSize: 50, higherIsBetter: true,
  },
  {
    key: "nps", name: "Net Tavsiye Skoru", nameEn: "Net Promoter Score",
    description: "0–10 tavsiye sorusunda 9–10 verenlerin oranından 0–6 verenlerin oranının farkı.",
    category: "EXPERIENCE", unit: "puan (−100…100)", formula: "%(score ≥ 9) − %(score ≤ 6)",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: null, minSampleSize: 50, higherIsBetter: true,
  },
  {
    key: "session_rating_mean", name: "Oturum değerlendirme ortalaması", nameEn: "Mean session rating",
    description: "Oturum bazlı değerlendirmelerin ortalaması; oturum başına en az örneklem şartıyla.",
    category: "EXPERIENCE", unit: "puan (1–5)", formula: "mean over sessions with n ≥ 10 of mean(session rating)",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: "sessions", minSampleSize: 30, higherIsBetter: true,
    surveyInputsCollectedBy: "sessions",
  },
  {
    key: "accessibility_satisfaction", name: "Erişilebilirlik memnuniyeti", nameEn: "Accessibility satisfaction",
    description: "Erişilebilirlik ihtiyacı beyan eden katılımcıların erişim deneyimi puanı.",
    category: "SOCIAL", unit: "puan (1–5)", formula: "weighted mean of Q_accessibility among respondents with declared needs",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: "community_impact", minSampleSize: 20, higherIsBetter: true,
  },
  {
    key: "complaint_theme_share", name: "Şikâyet temalarının dağılımı", nameEn: "Complaint theme share",
    description: "Açık uçlu yorumlarda olumsuz duyguyla etiketlenen temaların payı (NLP).",
    category: "EXPERIENCE", unit: "%", formula: "count(NEGATIVE aspect = theme) ÷ count(NEGATIVE aspects) × 100",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: null, minSampleSize: 50, higherIsBetter: false,
  },
  // ── Economic ────────────────────────────────────────────────────────────
  {
    key: "visitor_share", name: "Şehir dışı ziyaretçi oranı", nameEn: "Non-resident visitor share",
    description: "Ev adresi etkinlik ili dışında olan katılımcıların oranı.",
    category: "ECONOMIC", unit: "%", formula: "weighted share of respondents with home_province ≠ event province",
    dataSources: ["SURVEY", "REGISTRATION"], eventFormats: [], requiresModule: null, minSampleSize: 100, higherIsBetter: null,
    anyOf: [["SURVEY", "REGISTRATION"]],
  },
  {
    key: "mean_spend_per_visitor_day", name: "Ziyaretçi başı günlük ortalama harcama", nameEn: "Mean spend per visitor-day",
    description: "Şehir dışı ziyaretçilerin, grup büyüklüğüne bölünmüş günlük harcama ortalaması.",
    category: "ECONOMIC", unit: "TRY", formula: "Σ(spend ÷ party_size) ÷ Σ(days present), non-residents, trimmed at 1st/99th pct",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: "economic_impact", minSampleSize: 150, higherIsBetter: true,
  },
  {
    key: "mean_nights_stayed", name: "Ortalama konaklama süresi", nameEn: "Mean nights stayed",
    description: "Şehir dışı ziyaretçilerin etkinlik nedeniyle şehirde geçirdiği gece sayısı.",
    category: "ECONOMIC", unit: "gece", formula: "weighted mean of nights_stayed, non-residents",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: "economic_impact", minSampleSize: 150, higherIsBetter: true,
  },
  {
    key: "attributable_visitor_spend", name: "Etkinliğe atfedilebilir ziyaretçi harcaması", nameEn: "Attributable visitor spend",
    description: "Seviye 2: zaten gelecek olanlar ve yerel ikame düşüldükten sonra etkinlik nedeniyle şehre giren harcama.",
    category: "ECONOMIC", unit: "TRY", formula: "Σ grossed-up non-resident spend × (1 − deadweight) × (1 − displacement) — see calc run assumptions",
    dataSources: ["SURVEY", "CHECKIN", "REGISTRATION"], eventFormats: [], requiresModule: "economic_impact", minSampleSize: 200, higherIsBetter: true,
    anyOf: [["CHECKIN", "REGISTRATION"]],
  },
  {
    key: "local_business_turnover_change", name: "Yerel esnaf ciro değişimi (beyan)", nameEn: "Local business reported turnover change",
    description: "Esnaf anketinde etkinlik günlerinde olağan döneme göre beyan edilen ciro değişimi medyanı.",
    category: "ECONOMIC", unit: "%", formula: "median of reported % change vs. a typical comparable day",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: "economic_impact", minSampleSize: 40, higherIsBetter: true,
  },
  // ── Social ──────────────────────────────────────────────────────────────
  {
    key: "resident_support_index", name: "Yerel halk destek endeksi", nameEn: "Resident support index",
    description: "Yerel halkın etkinliğe yönelik tutum maddelerine katılım ortalaması.",
    category: "SOCIAL", unit: "puan (1–5)", formula: "weighted mean of resident attitude items (reverse-coded where negative)",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: "community_impact", minSampleSize: 200, higherIsBetter: true,
  },
  // ── Commercial / stakeholders ───────────────────────────────────────────
  {
    key: "sponsor_renewal_intent", name: "Sponsor devam niyeti", nameEn: "Sponsor renewal intent",
    description: "Sonraki edisyona sponsor olmayı düşündüğünü belirten sponsorların oranı.",
    category: "COMMERCIAL", unit: "%", formula: "sponsors answering likely/very likely ÷ responding sponsors × 100",
    dataSources: ["SURVEY"], eventFormats: [], requiresModule: "sponsorship", minSampleSize: 5, higherIsBetter: true,
  },
  {
    key: "leads_per_exhibitor", name: "Firma başına potansiyel müşteri", nameEn: "Leads per exhibitor",
    description: "Katılımcı firmaların beyan ettiği ya da taranan potansiyel müşteri sayısının medyanı.",
    category: "COMMERCIAL", unit: "kişi", formula: "median(leads per exhibitor)",
    dataSources: ["SURVEY", "FILE_UPLOAD"], eventFormats: [], requiresModule: "booths", minSampleSize: 10, higherIsBetter: true,
    anyOf: [["SURVEY", "FILE_UPLOAD"]],
  },
  {
    key: "b2b_meetings_completed", name: "Gerçekleşen B2B görüşme", nameEn: "B2B meetings completed",
    description: "Planlanan ve gerçekleştiği onaylanan birebir görüşme sayısı.",
    category: "COMMERCIAL", unit: "görüşme", formula: "count(meetings where status = COMPLETED)",
    dataSources: ["MANUAL_ENTRY"], eventFormats: [], requiresModule: "matchmaking", minSampleSize: null, higherIsBetter: true,
  },
  // ── Media ───────────────────────────────────────────────────────────────
  {
    key: "social_engagement_rate", name: "Sosyal medya etkileşim oranı", nameEn: "Social engagement rate",
    description: "Yetkili etkinlik hesaplarındaki etkileşimlerin erişime oranı.",
    category: "MEDIA", unit: "%", formula: "Σ engagements ÷ Σ reach × 100, owned accounts, event window",
    dataSources: ["SOCIAL_MEDIA"], eventFormats: [], requiresModule: "social_media", minSampleSize: null, higherIsBetter: true,
  },
  {
    key: "press_mentions", name: "Basında yer alma", nameEn: "Press mentions",
    description: "Etkinlik penceresinde etkinliğe atıf yapan basın haberi sayısı.",
    category: "MEDIA", unit: "haber", formula: "count(deduplicated press items mentioning the event)",
    dataSources: ["MANUAL_ENTRY", "EXTERNAL_API"], eventFormats: [], requiresModule: null, minSampleSize: null, higherIsBetter: true,
    anyOf: [["MANUAL_ENTRY", "EXTERNAL_API"]],
  },
  // ── Operations / finance ────────────────────────────────────────────────
  {
    key: "median_entry_wait", name: "Girişte ortanca bekleme", nameEn: "Median entry wait",
    description: "Girişte bekleme süresinin ortancası (tarama aralıklarından ya da gözlemden).",
    category: "OPERATIONS", unit: "dakika", formula: "median(queue join → ACCEPTED scan), or observed sample",
    dataSources: ["CHECKIN", "MANUAL_ENTRY"], eventFormats: [], requiresModule: "registration", minSampleSize: 30, higherIsBetter: false,
    anyOf: [["CHECKIN", "MANUAL_ENTRY"]],
  },
  {
    key: "incidents_per_10k", name: "10.000 katılımcı başına olay", nameEn: "Incidents per 10,000 attendees",
    description: "Kayıt altına alınan güvenlik/sağlık olaylarının katılımcı sayısına oranı.",
    category: "OPERATIONS", unit: "olay", formula: "count(incidents) ÷ attendance × 10,000",
    dataSources: ["MANUAL_ENTRY", "CHECKIN"], eventFormats: [], requiresModule: "site_operations", minSampleSize: null, higherIsBetter: false,
  },
  {
    key: "task_on_time_rate", name: "Zamanında tamamlanan görev oranı", nameEn: "Task on-time rate",
    description: "Son tarihinden önce tamamlanan görevlerin oranı.",
    category: "OPERATIONS", unit: "%", formula: "tasks DONE with completed_at ≤ due_at ÷ tasks with due_at × 100",
    dataSources: ["MANUAL_ENTRY"], eventFormats: [], requiresModule: null, minSampleSize: null, higherIsBetter: true,
  },
  {
    key: "budget_variance", name: "Bütçe sapması", nameEn: "Budget variance",
    description: "Gerçekleşen giderin planlanan gidere göre yüzde farkı.",
    category: "OPERATIONS", unit: "%", formula: "(Σ actual expense − Σ planned expense) ÷ Σ planned expense × 100",
    dataSources: ["FINANCE"], eventFormats: [], requiresModule: null, minSampleSize: null, higherIsBetter: false,
  },
  {
    key: "cost_per_attendee", name: "Katılımcı başı maliyet", nameEn: "Cost per attendee",
    description: "Toplam giderin tekil katılımcı sayısına oranı.",
    category: "OPERATIONS", unit: "TRY", formula: "Σ actual expense ÷ unique attendees",
    dataSources: ["FINANCE", "CHECKIN"], eventFormats: [], requiresModule: null, minSampleSize: null, higherIsBetter: false,
  },
] as const satisfies readonly MetricSeed[];

export type MetricKey = (typeof METRIC_LIBRARY)[number]["key"];

/** Metrics offerable to an event: active modules + type filter. This list becomes the KPI-stage enum. */
export function candidateMetrics(format: EventFormatValue, enabledModules: readonly string[]): MetricSeed[] {
  const mods = new Set(enabledModules);
  return (METRIC_LIBRARY as readonly MetricSeed[]).filter(
    (m) =>
      (m.requiresModule === null || mods.has(m.requiresModule)) &&
      (m.eventFormats.length === 0 || m.eventFormats.includes(format)),
  );
}
