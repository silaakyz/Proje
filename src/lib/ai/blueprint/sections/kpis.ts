/**
 * Blueprint section — KPI plan and the data requirements it implies.
 *
 * The model chooses from `candidateMetrics()` only (a per-event enum), ties each KPI to an objective
 * and may set a target only when it can name the basis. Data requirements and measurement tasks are
 * then derived deterministically from the chosen metrics.
 */
import { z } from "zod";
import { addDays } from "@/lib/ai/schemas/event-config";
import type { BlueprintCore } from "@/lib/ai/blueprint/core";
import type { PlannedTask } from "@/lib/ai/blueprint/sections/tasks";
import type { MetricDataSourceValue, SurveyAudienceValue } from "@/lib/domain/enums";
import { METRIC_LIBRARY, candidateMetrics, type MetricSeed } from "@/lib/metrics/library";
import { dataAvailableFrom } from "@/lib/metrics/validate";
import type { Release } from "@/lib/modules/registry";
import { QUESTION_BANK } from "@/lib/metrics/question-bank";

export const MAX_KPIS = 12;

export function buildKpisDraftSchema(candidateKeys: readonly string[]) {
  if (candidateKeys.length === 0) throw new Error("no candidate metrics");
  return z.object({
    kpis: z
      .array(
        z.object({
          metricKey: z.enum(candidateKeys as [string, ...string[]]),
          objectiveIndex: z.number().nullable().describe("0-based index of the objective this KPI measures; null for hygiene KPIs."),
          target: z.number().nullable().describe("Target in the metric's unit. ONLY when targetBasis can cite the organizer's words or arithmetic on them."),
          targetBasis: z.string().nullable().describe("Why this target, quoting the organizer, e.g. '500 kişilik etkinlik' → 500. null if no target."),
          rationale: z.string().describe("One sentence: why this KPI matters for this event."),
        }),
      )
      .describe(`Between 4 and ${MAX_KPIS} KPIs. Every EXPLICIT objective needs at least one KPI.`),
  });
}
export type KpisDraft = z.infer<ReturnType<typeof buildKpisDraftSchema>>;

export interface PlannedKpi {
  metricKey: string;
  objectiveIndex: number | null;
  target: number | null;
  targetBasis: string | null;
  rationale: string;
}

const BOUNDS: Record<string, [number, number]> = {
  "%": [0, 100],
  "puan (1–5)": [1, 5],
  "puan (−100…100)": [-100, 100],
};

export function normalizeKpis(draft: KpisDraft, core: BlueprintCore) {
  const repairs: string[] = [];
  const warnings: string[] = [];
  const candidates = new Map(
    candidateMetrics(core.event.format, core.modules.map((m) => m.key)).map((m) => [m.key, m] as const),
  );
  const seen = new Set<string>();
  const kpis: PlannedKpi[] = [];

  for (const k of draft.kpis) {
    const metric = candidates.get(k.metricKey);
    if (!metric || seen.has(k.metricKey)) continue;
    seen.add(k.metricKey);

    let objectiveIndex =
      k.objectiveIndex != null && Number.isInteger(k.objectiveIndex) && k.objectiveIndex >= 0 && k.objectiveIndex < core.objectives.length
        ? k.objectiveIndex
        : null;
    if (k.objectiveIndex != null && objectiveIndex === null) repairs.push(`kpi '${k.metricKey}': bad objectiveIndex dropped`);

    let target = k.target;
    let targetBasis = k.targetBasis?.trim() || null;
    if (target != null && !targetBasis) {
      repairs.push(`kpi '${k.metricKey}': target without basis dropped`);
      target = null;
    }
    const b = BOUNDS[metric.unit];
    if (target != null && b && (target < b[0] || target > b[1])) {
      repairs.push(`kpi '${k.metricKey}': target ${target} outside ${metric.unit}; dropped`);
      target = null;
      targetBasis = null;
    }
    kpis.push({ metricKey: k.metricKey, objectiveIndex, target, targetBasis: target == null ? null : targetBasis, rationale: k.rationale.trim() });
    if (kpis.length === MAX_KPIS) break;
  }

  core.objectives.forEach((o, i) => {
    if (o.origin === "EXPLICIT" && !kpis.some((k) => k.objectiveIndex === i))
      warnings.push(`"${o.text}" hedefi için KPI seçilmedi.`);
  });
  for (const k of kpis) {
    const from = dataAvailableFrom(candidates.get(k.metricKey)!);
    if (from === "V0.4" || from === "V1.0")
      warnings.push(`'${k.metricKey}' verisi platformda ${from} sürümüne kadar otomatik toplanamaz; o zamana kadar elle girilmesi gerekir.`);
  }
  return { kpis, repairs, warnings };
}

// ---------------------------------------------------------------------------
// Data requirements → measurement tasks (deterministic)
// ---------------------------------------------------------------------------

export interface DataRequirements {
  /** Audience → minimum responses needed (max over that audience's KPIs). */
  surveys: { audience: SurveyAudienceValue; minResponses: number; metricKeys: string[] }[];
  /** Non-survey sources and which KPIs need them. */
  sources: { source: MetricDataSourceValue; metricKeys: string[] }[];
  /** KPI → release in which the platform can collect its inputs (see dataAvailableFrom). */
  availableFrom: Record<string, Release>;
}

const LIB = new Map<string, MetricSeed>(METRIC_LIBRARY.map((m) => [m.key, m]));

export function deriveDataRequirements(kpis: readonly PlannedKpi[]): DataRequirements {
  const surveys = new Map<SurveyAudienceValue, { minResponses: number; metricKeys: string[] }>();
  const sources = new Map<MetricDataSourceValue, string[]>();
  for (const k of kpis) {
    const m = LIB.get(k.metricKey);
    if (!m) continue;
    const bank = QUESTION_BANK[m.key as keyof typeof QUESTION_BANK];
    if (bank) {
      const cur = surveys.get(bank.audience) ?? { minResponses: 0, metricKeys: [] };
      cur.minResponses = Math.max(cur.minResponses, m.minSampleSize ?? 0);
      cur.metricKeys.push(m.key);
      surveys.set(bank.audience, cur);
    }
    for (const s of m.dataSources) {
      if (s === "SURVEY" && bank) continue;
      sources.set(s, [...(sources.get(s) ?? []), m.key]);
    }
  }
  return {
    surveys: [...surveys].map(([audience, v]) => ({ audience, ...v })),
    sources: [...sources].map(([source, metricKeys]) => ({ source, metricKeys })),
    availableFrom: Object.fromEntries(
      kpis.filter((k) => LIB.has(k.metricKey)).map((k) => [k.metricKey, dataAvailableFrom(LIB.get(k.metricKey)!)]),
    ),
  };
}

const AUDIENCE_LABEL: Record<SurveyAudienceValue, string> = {
  ATTENDEE: "Katılımcı", SPONSOR: "Sponsor", EXHIBITOR: "Katılımcı firma", LOCAL_BUSINESS: "Yerel esnaf",
  ORGANIZER: "Organizasyon ekibi", RESIDENT: "Yerel halk", PUBLIC_AUTHORITY: "Kamu paydaşı",
};

const SOURCE_TASK: Partial<Record<MetricDataSourceValue, { title: string; offset: number; description: string }>> = {
  MANUAL_ENTRY: { title: "Saha sayım ve olay kayıt yöntemini belirle", offset: -14, description: "Kapı sayımı, olay kaydı ve gözlem formlarının kim tarafından, hangi aralıkla doldurulacağını netleştir." },
  EXTERNAL_API: { title: "Harici veri kaynaklarının erişimini doğrula", offset: -21, description: "Sayım cihazı veya harici sistemlerin veri aktarımını test et." },
  FINANCE: { title: "Gerçekleşen bütçe kalemlerini gir", offset: 14, description: "Planlanan bütçe satırlarına gerçekleşen tutarları işle." },
  SOCIAL_MEDIA: { title: "Sosyal medya ölçüm dönemini ve hesapları belirle", offset: -30, description: "Ölçülecek resmi hesapları ve ölçüm penceresini kaydet. Otomatik entegrasyon gelene kadar veriler elle girilir." },
  FILE_UPLOAD: { title: "Katılımcı firmalardan veri dosyalarını topla", offset: 7, description: "Potansiyel müşteri listeleri gibi dosyaları şablonla topla." },
};

/** Measurement-board tasks implied by the KPI plan. Keys are prefixed `m_` and stable across regenerations. */
export function deriveMeasurementTasks(req: DataRequirements, core: BlueprintCore): PlannedTask[] {
  const lastDay = (core.event.durationDays ?? 1) - 1;
  const out: Omit<PlannedTask, "position" | "dueDate">[] = [];
  for (const s of req.surveys) {
    const label = AUDIENCE_LABEL[s.audience];
    const a = s.audience.toLowerCase();
    out.push(
      { key: `m_survey_${a}_finalize`, title: `${label} anketini son haline getir`, description: `Ölçülen KPI'lar: ${s.metricKeys.join(", ")}.`,
        workstream: "data_collection", board: "MEASUREMENT", phase: "PREPARE", priority: "HIGH", dueOffsetDays: -21,
        assigneeRole: "Ölçüm sorumlusu", dependsOnKeys: [], stakeholderKind: null },
      { key: `m_survey_${a}_collect`, title: `${label} anketini uygula (hedef en az ${s.minResponses || 30} yanıt)`,
        description: "Yanıt sayısı hedefin altında kalırsa ilgili KPI'lar 'yetersiz veri' olarak raporlanır.",
        workstream: "data_collection", board: "MEASUREMENT", phase: "RUN", priority: "HIGH", dueOffsetDays: lastDay + 3,
        assigneeRole: "Ölçüm sorumlusu", dependsOnKeys: [`m_survey_${a}_finalize`], stakeholderKind: null },
    );
  }
  for (const s of req.sources) {
    const t = SOURCE_TASK[s.source];
    if (!t) continue;
    out.push({ key: `m_source_${s.source.toLowerCase()}`, title: t.title, description: `${t.description} (KPI: ${s.metricKeys.join(", ")})`,
      workstream: "data_collection", board: "MEASUREMENT", phase: t.offset > 0 ? "ANALYZE" : "PREPARE", priority: "MEDIUM",
      dueOffsetDays: t.offset > 0 ? lastDay + t.offset : t.offset, assigneeRole: "Ölçüm sorumlusu", dependsOnKeys: [], stakeholderKind: null });
  }
  out.push({ key: "m_report_draft", title: "Etkinlik sonrası raporu hazırla ve onaya sun",
    description: "KPI sonuçları, veri yeterliliği ve hesaplama varsayımlarıyla birlikte.", workstream: "reporting",
    board: "MEASUREMENT", phase: "ANALYZE", priority: "HIGH", dueOffsetDays: lastDay + 21, assigneeRole: "Proje yöneticisi",
    dependsOnKeys: out.filter((t) => t.key.endsWith("_collect")).map((t) => t.key), stakeholderKind: null });

  return out.map((t, i) => ({
    ...t,
    dueDate: core.event.startDate && t.dueOffsetDays != null ? addDays(core.event.startDate, t.dueOffsetDays) : null,
    position: `m${i.toString(36).padStart(4, "0")}`,
  }));
}
