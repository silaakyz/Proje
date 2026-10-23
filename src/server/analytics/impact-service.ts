/**
 * Impact calculation for an event (0007): inputs, multiplier sets, readiness and stored runs.
 *
 * Inputs read on the event's real data:
 *  - attendance: check-ins if any, else issued (not voided) tickets, else the organizer's estimate
 *    from the event profile (ai_config.event.expectedAttendance), else unknown;
 *  - responses: non-excluded ATTENDEE survey responses of the event (all versions), with their spend lines;
 *  - assumptions and the multiplier set: event_impact_inputs, as recorded by owner/admin with sources;
 *  - region: ai_config.event.nuts2Code.
 * A run stores the gate's checks, the exact inputs and only the figures its level reached; runs are
 * immutable (trigger) and a report cites a run id.
 */
import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import {
  attendees, eventImpactInputs, events, impactCalculationRuns, impactLevel, multipliers, multiplierSets, multiplierType,
  regionalizationMethod, surveyResponseSpend, surveyResponses,
} from "@/db/schema";
import { calculateImpact, type EngineInput, type EngineResponse } from "@/lib/impact/engine";
import { ATTRIBUTION_METHODS, IMPACT_LEVELS, type AttributionMethod, type ImpactAssumptions, type ImpactLevel } from "@/lib/impact/sufficiency";
import { SPEND_CATEGORIES, type SpendCategoryValue } from "@/lib/metrics/question-bank";
import type { UserDbRunner } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";

export { IMPACT_LEVELS };

const DB_LEVEL = { SPEND: "spend", ATTRIBUTABLE_SPEND: "attributable_spend", ECONOMIC_IMPACT: "economic_impact" } as const;
type DbLevel = (typeof impactLevel.enumValues)[number];
const toApiLevel = (l: DbLevel): ImpactLevel | null =>
  l === "insufficient_data" ? null : (Object.keys(DB_LEVEL) as ImpactLevel[]).find((k) => DB_LEVEL[k] === l)!;

const sourced = z.object({ value: z.number().min(0).max(1), source: z.string().trim().min(10).max(500) });
export const impactInputsSchema = z.object({
  organizationId: z.uuid(),
  priceYear: z.number().int().min(2000).max(2100),
  attributionMethod: z.enum(ATTRIBUTION_METHODS).default("SURVEY_STRICT"),
  deadweight: sourced.nullable().default(null),
  displacement: sourced.nullable().default(null),
  leakage: sourced.nullable().default(null),
  multiplierSetId: z.uuid().nullable().default(null),
}).refine((i) => i.attributionMethod !== "RECORDED_DEADWEIGHT" || i.deadweight !== null,
  { message: "RECORDED_DEADWEIGHT needs a sourced deadweight", path: ["deadweight"] });

export const multiplierSetSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  source: z.string().trim().min(10).max(1000),
  ioBaseYear: z.number().int().min(1990).max(2100),
  priceYear: z.number().int().min(1990).max(2100),
  nuts2Code: z.string().regex(/^TR[1-9A-C][0-9]$/).nullable(),
  method: z.enum(regionalizationMethod.enumValues),
  multiplierType: z.enum(multiplierType.enumValues),
  coefficients: z.array(z.object({
    spendCategory: z.enum(SPEND_CATEGORIES),
    a64Code: z.string().trim().min(1).max(16).optional(),
    output: z.number().min(0).max(9999),
    valueAdded: z.number().min(0).max(9999),
    income: z.number().min(0).max(9999),
    employmentPerMTry: z.number().min(0).max(9999).nullable(),
  })).min(1).max(SPEND_CATEGORIES.length)
    .refine((cs) => new Set(cs.map((c) => c.spendCategory)).size === cs.length, "one coefficient row per spend category"),
}).refine((s) => (s.nuts2Code === null) === (s.method === "NATIONAL"), { message: "a national set has no region; a regional set needs one", path: ["nuts2Code"] });

export const multiplierSetActiveSchema = z.object({ organizationId: z.uuid(), isActive: z.boolean() });
export const runSchema = z.object({ organizationId: z.uuid(), level: z.enum(IMPACT_LEVELS).default("ECONOMIC_IMPACT") });

async function eventInOrg(organizationId: string, eventId: string) {
  const [ev] = await adminDb.select({ id: events.id, status: events.status, aiConfig: events.aiConfig })
    .from(events).where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  return ev;
}

const num = (v: string | null) => (v === null ? null : Number(v));

// --------------------------------------------------------------------------- inputs

export async function getImpactInputs(organizationId: string, eventId: string) {
  const [row] = await adminDb.select().from(eventImpactInputs)
    .where(and(eq(eventImpactInputs.eventId, eventId), eq(eventImpactInputs.organizationId, organizationId))).limit(1);
  if (!row) return null;
  const pair = (v: string | null, s: string | null) => (v === null ? null : { value: Number(v), source: s! });
  return {
    priceYear: row.priceYear,
    attributionMethod: row.attributionMethod as AttributionMethod,
    deadweight: pair(row.deadweight, row.deadweightSource),
    displacement: pair(row.displacement, row.displacementSource),
    leakage: pair(row.leakage, row.leakageSource),
    multiplierSetId: row.multiplierSetId,
    updatedAt: row.updatedAt,
  };
}

export async function putImpactInputs(eventId: string, userId: string, input: z.infer<typeof impactInputsSchema>) {
  const org = input.organizationId;
  await eventInOrg(org, eventId);
  if (input.multiplierSetId) {
    const [ms] = await adminDb.select({ id: multiplierSets.id }).from(multiplierSets)
      .where(and(eq(multiplierSets.id, input.multiplierSetId), eq(multiplierSets.organizationId, org))).limit(1);
    if (!ms) throw new ApiError(404, "Multiplier set not found");
  }
  const values = {
    priceYear: input.priceYear,
    attributionMethod: input.attributionMethod,
    deadweight: input.deadweight ? String(input.deadweight.value) : null, deadweightSource: input.deadweight?.source ?? null,
    displacement: input.displacement ? String(input.displacement.value) : null, displacementSource: input.displacement?.source ?? null,
    leakage: input.leakage ? String(input.leakage.value) : null, leakageSource: input.leakage?.source ?? null,
    multiplierSetId: input.multiplierSetId, updatedBy: userId, updatedAt: new Date(),
  };
  await adminDb.insert(eventImpactInputs).values({ eventId, organizationId: org, ...values })
    .onConflictDoUpdate({ target: eventImpactInputs.eventId, set: values, setWhere: eq(eventImpactInputs.organizationId, org) });
  return getImpactInputs(org, eventId);
}

// --------------------------------------------------------------------------- multiplier sets

export async function createMultiplierSet(userId: string, input: z.infer<typeof multiplierSetSchema>) {
  const org = input.organizationId;
  return adminDb.transaction(async (tx) => {
    const [set] = await tx.insert(multiplierSets).values({
      organizationId: org, name: input.name, source: input.source, ioBaseYear: input.ioBaseYear, priceYear: input.priceYear,
      nuts2Code: input.nuts2Code, method: input.method, multiplierType: input.multiplierType, createdBy: userId,
    }).returning();
    await tx.insert(multipliers).values(input.coefficients.map((c) => ({
      setId: set!.id, organizationId: org, spendCategory: c.spendCategory, a64Code: c.a64Code ?? null,
      output: String(c.output), valueAdded: String(c.valueAdded), income: String(c.income), employmentPerMTry: c.employmentPerMTry === null ? null : String(c.employmentPerMTry),
    })));
    return { ...set!, coefficients: input.coefficients };
  });
}

/** Members read the organization's sets under RLS. */
export async function listMultiplierSets(runAsUser: UserDbRunner, organizationId: string) {
  return runAsUser(async (tx) => {
    const sets = await tx.select().from(multiplierSets).where(eq(multiplierSets.organizationId, organizationId)).orderBy(desc(multiplierSets.createdAt));
    const coefs = sets.length
      ? await tx.select().from(multipliers).where(and(eq(multipliers.organizationId, organizationId), inArray(multipliers.setId, sets.map((s) => s.id))))
        .orderBy(asc(multipliers.spendCategory))
      : [];
    return sets.map((s) => ({
      ...s,
      coefficients: coefs.filter((c) => c.setId === s.id).map((c) => ({
        spendCategory: c.spendCategory, a64Code: c.a64Code, output: Number(c.output), valueAdded: Number(c.valueAdded),
        income: Number(c.income), employmentPerMTry: c.employmentPerMTry === null ? null : Number(c.employmentPerMTry),
      })),
    }));
  });
}

export async function setMultiplierSetActive(setId: string, input: z.infer<typeof multiplierSetActiveSchema>) {
  const [row] = await adminDb.update(multiplierSets).set({ isActive: input.isActive, updatedAt: new Date() })
    .where(and(eq(multiplierSets.id, setId), eq(multiplierSets.organizationId, input.organizationId)))
    .returning({ id: multiplierSets.id, isActive: multiplierSets.isActive });
  if (!row) throw new ApiError(404, "Multiplier set not found");
  return row;
}

// --------------------------------------------------------------------------- engine input

async function loadEngineInput(organizationId: string, eventId: string, requestedLevel: ImpactLevel) {
  const ev = await eventInOrg(organizationId, eventId);
  const [att] = await adminDb.select({ total: sql<number>`count(*)::int`, checkedIn: sql<number>`count(*) filter (where ${attendees.isCheckedIn})::int` })
    .from(attendees).where(and(eq(attendees.organizationId, organizationId), eq(attendees.eventId, eventId), isNull(attendees.cancelledAt)));
  const profile = (ev.aiConfig?.event ?? null) as { expectedAttendance?: number | null; nuts2Code?: string | null } | null;
  const total = Number(att?.total ?? 0);
  const checkedIn = Number(att?.checkedIn ?? 0);
  const attendance: EngineInput["attendance"] =
    checkedIn > 0 ? { basis: "CHECKIN", value: checkedIn }
    : total > 0 ? { basis: "REGISTRATION", value: total }
    : profile?.expectedAttendance ? { basis: "ORGANIZER_ESTIMATE", value: profile.expectedAttendance }
    : null;

  const rows = await adminDb
    .select({
      id: surveyResponses.id, weight: surveyResponses.weight, isLocalResident: surveyResponses.isLocalResident, partySize: surveyResponses.partySize,
      daysPresent: surveyResponses.daysPresent, wouldVisitAnyway: surveyResponses.wouldVisitAnyway, mainReason: surveyResponses.mainReason,
    })
    .from(surveyResponses)
    .where(and(eq(surveyResponses.organizationId, organizationId), eq(surveyResponses.eventId, eventId),
      eq(surveyResponses.audience, "ATTENDEE"), eq(surveyResponses.isExcluded, false)));
  const spend = rows.length
    ? await adminDb.select({ responseId: surveyResponseSpend.responseId, category: surveyResponseSpend.category, amountKurus: surveyResponseSpend.amountKurus })
      .from(surveyResponseSpend)
      .innerJoin(surveyResponses, eq(surveyResponses.id, surveyResponseSpend.responseId))
      .where(and(eq(surveyResponseSpend.organizationId, organizationId), eq(surveyResponses.eventId, eventId),
        eq(surveyResponses.audience, "ATTENDEE"), eq(surveyResponses.isExcluded, false)))
    : [];
  const spendBy = new Map<string, Partial<Record<SpendCategoryValue, number>>>();
  for (const s of spend) (spendBy.get(s.responseId) ?? spendBy.set(s.responseId, {}).get(s.responseId)!)[s.category] = s.amountKurus;
  const responses: EngineResponse[] = rows.map((r) => ({
    weight: Number(r.weight), isLocalResident: r.isLocalResident, partySize: r.partySize, daysPresent: r.daysPresent,
    wouldVisitAnyway: r.wouldVisitAnyway, mainReason: r.mainReason, spendKurus: spendBy.get(r.id) ?? {},
  }));

  const inputs = await getImpactInputs(organizationId, eventId);
  const assumptions: ImpactAssumptions | null = inputs
    ? {
      priceYear: inputs.priceYear,
      attributionMethod: inputs.attributionMethod,
      ...(inputs.deadweight ? { deadweight: inputs.deadweight } : {}),
      ...(inputs.displacement ? { displacement: inputs.displacement } : {}),
      ...(inputs.leakage ? { leakage: inputs.leakage } : {}),
    }
    : null;

  let multiplierSet: EngineInput["multiplierSet"] = null;
  if (inputs?.multiplierSetId) {
    const [ms] = await adminDb.select().from(multiplierSets)
      .where(and(eq(multiplierSets.id, inputs.multiplierSetId), eq(multiplierSets.organizationId, organizationId))).limit(1);
    if (ms) {
      const coefs = await adminDb.select().from(multipliers).where(and(eq(multipliers.setId, ms.id), eq(multipliers.organizationId, organizationId)));
      multiplierSet = {
        id: ms.id, nuts2Code: ms.nuts2Code, isActive: ms.isActive, method: ms.method, priceYear: ms.priceYear,
        coefficients: coefs.map((c) => ({
          spendCategory: c.spendCategory, output: Number(c.output), valueAdded: Number(c.valueAdded), income: Number(c.income),
          employmentPerMTry: c.employmentPerMTry === null ? null : Number(c.employmentPerMTry),
        })),
      };
    }
  }

  const engineInput: EngineInput = {
    requestedLevel, attendance, responses, assumptions, eventNuts2Code: profile?.nuts2Code ?? null, multiplierSet,
  };
  return { ev, engineInput, inputs };
}

// --------------------------------------------------------------------------- readiness, runs

/** The gate and the response counts on live data; no figure (figures come only from stored runs). */
export async function impactReadiness(organizationId: string, eventId: string, requestedLevel: ImpactLevel) {
  const { ev, engineInput, inputs } = await loadEngineInput(organizationId, eventId, requestedLevel);
  const r = calculateImpact(engineInput);
  const [latest] = await adminDb.select({ id: impactCalculationRuns.id, createdAt: impactCalculationRuns.createdAt, achievedLevel: impactCalculationRuns.achievedLevel })
    .from(impactCalculationRuns)
    .where(and(eq(impactCalculationRuns.organizationId, organizationId), eq(impactCalculationRuns.eventId, eventId)))
    .orderBy(desc(impactCalculationRuns.createdAt)).limit(1);
  return {
    eventId,
    eventStatus: ev.status,
    inputs: {
      attendance: engineInput.attendance,
      responses: { nonResidentWithSpend: r.counts.nonResidentWithSpend, withAttributionAnswers: r.counts.withAttributionAnswers },
      responseCounts: r.counts,
      eventNuts2Code: engineInput.eventNuts2Code,
      assumptionsRecorded: !!inputs,
      assumptions: inputs,
      multiplierSet: engineInput.multiplierSet ? { id: engineInput.multiplierSet.id, nuts2Code: engineInput.multiplierSet.nuts2Code,
        priceYear: engineInput.multiplierSet.priceYear, categories: engineInput.multiplierSet.coefficients.map((c) => c.spendCategory) } : null,
    },
    assessment: { engineVersion: r.engineVersion, requestedLevel: r.requestedLevel, achievedLevel: r.achievedLevel, status: r.status, checks: r.checks },
    /** Readiness never produces a figure; POST …/impact/runs stores a run with its figures. */
    figures: null,
    latestRun: latest ? { id: latest.id, createdAt: latest.createdAt, achievedLevel: toApiLevel(latest.achievedLevel) } : null,
    dataNotes: [
      "Eşik değerleri (minimum örneklem) metrik kütüphanesindeki henüz incelenmemiş varsayılanlardır.",
      "Rakamlar yalnızca kaydedilen hesaplama çalıştırmalarında üretilir; her çalıştırma değiştirilemez ve girdileriyle saklanır.",
    ],
  };
}

const toRun = (r: typeof impactCalculationRuns.$inferSelect) => ({
  id: r.id, eventId: r.eventId, requestedLevel: toApiLevel(r.requestedLevel), achievedLevel: toApiLevel(r.achievedLevel), status: r.status,
  engineVersion: r.engineVersion, checks: r.dataSufficiency, inputSnapshot: r.inputSnapshot, multiplierSetId: r.multiplierSetId,
  attendanceBasis: r.attendanceBasis, attendanceUsed: r.attendanceUsed, sampleSize: r.sampleSize,
  figures: r.grossDirectSpend === null ? null : {
    grossDirectSpend: num(r.grossDirectSpend), attributableSpend: num(r.attributableSpend), totalOutputImpact: num(r.totalOutputImpact),
    totalValueAdded: num(r.totalValueAdded), totalIncome: num(r.totalIncome), totalEmploymentFte: num(r.totalEmploymentFte),
  },
  breakdown: r.breakdown, triggeredBy: r.triggeredBy, createdAt: r.createdAt,
});

export async function runImpactCalculation(eventId: string, userId: string, input: z.infer<typeof runSchema>) {
  const org = input.organizationId;
  const { engineInput } = await loadEngineInput(org, eventId, input.level);
  const r = calculateImpact(engineInput);
  const reached = r.achievedLevel !== null;
  const f = r.figures;
  const str = (v: number | undefined) => (v === undefined ? null : v.toFixed(2));
  const [row] = await adminDb.insert(impactCalculationRuns).values({
    organizationId: org, eventId, requestedLevel: DB_LEVEL[input.level], achievedLevel: r.achievedLevel ? DB_LEVEL[r.achievedLevel] : "insufficient_data",
    status: r.status, engineVersion: r.engineVersion, dataSufficiency: r.checks,
    inputSnapshot: {
      attendance: engineInput.attendance, responseCounts: r.counts, assumptions: engineInput.assumptions, eventNuts2Code: engineInput.eventNuts2Code,
      multiplierSet: engineInput.multiplierSet,
    },
    multiplierSetId: r.achievedLevel === "ECONOMIC_IMPACT" ? engineInput.multiplierSet!.id : null,
    attendanceBasis: reached ? engineInput.attendance!.basis : (engineInput.attendance?.basis ?? null),
    attendanceUsed: reached ? engineInput.attendance!.value : (engineInput.attendance?.value ?? null),
    sampleSize: r.counts.nonResidentWithSpend,
    grossDirectSpend: str(f?.grossDirectSpend), attributableSpend: str(f?.attributableSpend), totalOutputImpact: str(f?.totalOutputImpact),
    totalValueAdded: str(f?.totalValueAdded), totalIncome: str(f?.totalIncome), totalEmploymentFte: str(f?.totalEmploymentFte),
    breakdown: r.breakdown, triggeredBy: userId,
  }).returning();
  return toRun(row!);
}

/** One stored run, read under RLS by any member (org.read); another organization's run is a 404. */
export async function getImpactRun(runAsUser: UserDbRunner, organizationId: string, runId: string) {
  const [row] = await runAsUser((tx) => tx.select().from(impactCalculationRuns)
    .where(and(eq(impactCalculationRuns.id, runId), eq(impactCalculationRuns.organizationId, organizationId))).limit(1));
  if (!row) throw new ApiError(404, "Impact run not found");
  return toRun(row);
}

/** Members read the event's runs under RLS, newest first. */
export async function listImpactRuns(runAsUser: UserDbRunner, organizationId: string, eventId: string) {
  await eventInOrg(organizationId, eventId);
  const rows = await runAsUser((tx) => tx.select().from(impactCalculationRuns)
    .where(and(eq(impactCalculationRuns.organizationId, organizationId), eq(impactCalculationRuns.eventId, eventId)))
    .orderBy(desc(impactCalculationRuns.createdAt)).limit(100));
  return rows.map(toRun);
}
