/**
 * Runtime validation of the Metric Evidence Registry seed.
 * Run by the unit tests (the library lives in code; there is no database seed).
 */
import { z } from "zod";
import { EVENT_FORMATS, METRIC_CATEGORIES, METRIC_DATA_SOURCES } from "@/lib/domain/enums";
import { METRIC_LIBRARY, type MetricSeed } from "@/lib/metrics/library";
import { QUESTION_BANK } from "@/lib/metrics/question-bank";
import { MODULE_KEYS, getModule, type Release } from "@/lib/modules/registry";

export const metricSeedSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  name: z.string().min(3),
  nameEn: z.string().min(3),
  description: z.string().min(10),
  category: z.enum(METRIC_CATEGORIES),
  unit: z.string().min(1),
  formula: z.string().min(5),
  dataSources: z.array(z.enum(METRIC_DATA_SOURCES)).min(1),
  eventFormats: z.array(z.enum(EVENT_FORMATS)),
  requiresModule: z.enum(MODULE_KEYS).nullable(),
  minSampleSize: z.number().int().positive().nullable(),
  higherIsBetter: z.boolean().nullable(),
  surveyInputsCollectedBy: z.enum(MODULE_KEYS).optional(),
  anyOf: z.array(z.array(z.enum(METRIC_DATA_SOURCES)).min(2)).optional(),
});

/** DB-side evidence record shape (analytics.metric_definitions.evidence). */
export const evidenceItemSchema = z.object({
  citation: z.string().min(10),
  doi: z.string().optional(),
  url: z.url().optional(),
  note: z.string().optional(),
});

export interface LibraryIssue {
  key: string;
  issue: string;
}

export function validateMetricLibrary(lib: readonly MetricSeed[] = METRIC_LIBRARY): LibraryIssue[] {
  const issues: LibraryIssue[] = [];
  const seen = new Set<string>();
  for (const m of lib) {
    const parsed = metricSeedSchema.safeParse(m);
    if (!parsed.success) issues.push({ key: m.key, issue: z.prettifyError(parsed.error) });
    if (seen.has(m.key)) issues.push({ key: m.key, issue: "duplicate key" });
    seen.add(m.key);
    if (new Set(m.dataSources).size !== m.dataSources.length) issues.push({ key: m.key, issue: "duplicate data source" });
    for (const g of m.anyOf ?? [])
      for (const src of g) if (!m.dataSources.includes(src)) issues.push({ key: m.key, issue: `anyOf source ${src} not in dataSources` });

    // Required inputs: every survey-sourced metric must be collectable.
    const bank = QUESTION_BANK[m.key as keyof typeof QUESTION_BANK];
    if (m.dataSources.includes("SURVEY") && !bank && !m.surveyInputsCollectedBy)
      issues.push({ key: m.key, issue: "SURVEY source but no question-bank entry or collecting module" });
    if (bank && !bank.questions.some((q) => q.measures.includes(m.key)))
      issues.push({ key: m.key, issue: "question-bank entry has no question that measures this metric" });
    if (bank && !m.dataSources.includes("SURVEY")) issues.push({ key: m.key, issue: "bank entry but SURVEY not a data source" });
    if (m.surveyInputsCollectedBy && m.surveyInputsCollectedBy !== m.requiresModule)
      issues.push({ key: m.key, issue: "collecting module must also be the required module" });
  }
  // Bank questions must only claim to measure known metrics.
  for (const entry of Object.values(QUESTION_BANK))
    for (const q of entry!.questions)
      for (const k of q.measures) if (!seen.has(k)) issues.push({ key: k, issue: `question '${q.key}' measures unknown metric` });
  return issues;
}

const ORDER: Release[] = ["V0.1", "V0.2", "V0.3", "V0.4", "V1.0"];
const maxRelease = (rs: Release[]) => rs.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "V0.1" as Release);

/** Release in which the platform can actually collect this metric's inputs (roadmap-based). */
const SOURCE_RELEASE: Record<(typeof METRIC_DATA_SOURCES)[number], Release> = {
  REGISTRATION: "V0.2", CHECKIN: "V0.2", SURVEY: "V0.3", MANUAL_ENTRY: "V0.3", FILE_UPLOAD: "V0.3",
  FINANCE: "V0.3", SOCIAL_MEDIA: "V1.0", EXTERNAL_API: "V1.0",
};

const minRelease = (rs: Release[]) => rs.reduce((a, b) => (ORDER.indexOf(b) < ORDER.indexOf(a) ? b : a), "V1.0" as Release);

export function dataAvailableFrom(m: MetricSeed): Release {
  const mod = m.requiresModule ? getModule(m.requiresModule)?.availableIn ?? "V1.0" : "V0.1";
  const grouped = new Set((m.anyOf ?? []).flat());
  const required = m.dataSources.filter((s) => !grouped.has(s)).map((s) => SOURCE_RELEASE[s]);
  // An "any of" group is available as soon as its earliest source is.
  const groups = (m.anyOf ?? []).map((g) => minRelease(g.map((s) => SOURCE_RELEASE[s])));
  return maxRelease([mod, ...required, ...groups]);
}
