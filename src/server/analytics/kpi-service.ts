/**
 * KPI values of an event: loads what the platform collected (tickets, check-ins, tasks, attendee survey
 * responses) and runs the pure KPI engine (src/lib/kpi/engine.ts) on it. Read-only; computed on request so the
 * numbers always reflect the current data. Aggregates only — no respondent-level data leaves this module.
 * Called after the route checked org.read; every query is scoped to the caller's organization.
 *
 * Event KPIs (event_kpis) whose metric the engine computes get that value as their actual; for the others the
 * organizer may record an actual by hand (updateKpi), stored in event_kpis.actual_value with source "manual".
 */
import "server-only";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { adminDb } from "@/db";
import { attendees, budgetItems, eventKpis, events, surveyResponses, surveyResponseSpend, tasks } from "@/db/schema";
import { allowsManualFallback, KPI_BY_ID, KPI_CATALOG_VERSION, LIBRARY_TO_CATALOG } from "@/lib/kpi/catalog";
import { computeKpis, KPI_ENGINE_VERSION, type FinanceLine, type KpiResponse, type KpiValue } from "@/lib/kpi/engine";
import type { SpendCategoryValue } from "@/lib/metrics/question-bank";
import { todayIstanbul } from "@/lib/time/istanbul";
import { ApiError } from "@/server/http";
import { loadExternalData } from "@/server/connectors/external-data";
import { loadConfirmedDatasets } from "@/server/datasets/dataset-service";

const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

/** `finance`: whether the caller may see budget data (budget.read); otherwise finance metrics stay empty. */
export async function eventKpiValues(organizationId: string, eventId: string, { finance }: { finance: boolean }) {
  const [ev] = await adminDb
    .select({ startDate: events.startDate, endDate: events.endDate, status: events.status, aiConfig: events.aiConfig })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
    .limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  const scope = and(eq(attendees.organizationId, organizationId), eq(attendees.eventId, eventId));

  const [t] = await adminDb
    .select({
      valid: sql<number>`count(*) filter (where ${attendees.cancelledAt} is null)::int`,
      cancelled: sql<number>`count(*) filter (where ${attendees.cancelledAt} is not null)::int`,
      checkedIn: sql<number>`count(*) filter (where ${attendees.isCheckedIn})::int`,
      leadDaysSum: ev.startDate
        ? sql<number>`coalesce(sum(greatest(0, ${ev.startDate}::date - (${attendees.createdAt} at time zone 'Europe/Istanbul')::date)) filter (where ${attendees.cancelledAt} is null), 0)::float`
        : sql<number>`0::float`,
      leadDaysN: ev.startDate ? sql<number>`count(*) filter (where ${attendees.cancelledAt} is null)::int` : sql<number>`0`,
    })
    .from(attendees)
    .where(scope);

  const today = todayIstanbul();
  const [tk] = await adminDb
    .select({
      dueReached: sql<number>`count(*) filter (where ${tasks.dueDate} <= ${today}::date)::int`,
      onTime: sql<number>`count(*) filter (where ${tasks.dueDate} <= ${today}::date and ${tasks.status} = 'DONE'
        and (${tasks.completedAt} at time zone 'Europe/Istanbul')::date <= ${tasks.dueDate})::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.eventId, eventId), isNotNull(tasks.dueDate)));

  const rows = await adminDb
    .select({
      id: surveyResponses.id, weight: surveyResponses.weight, answers: surveyResponses.answers, isLocalResident: surveyResponses.isLocalResident,
      homeProvinceCode: surveyResponses.homeProvinceCode, partySize: surveyResponses.partySize, daysPresent: surveyResponses.daysPresent,
      nightsStayed: surveyResponses.nightsStayed, mainReason: surveyResponses.mainReason, wouldVisitAnyway: surveyResponses.wouldVisitAnyway,
    })
    .from(surveyResponses)
    .where(and(eq(surveyResponses.organizationId, organizationId), eq(surveyResponses.eventId, eventId),
      eq(surveyResponses.audience, "ATTENDEE"), eq(surveyResponses.isExcluded, false)));
  const spend = rows.length
    ? await adminDb
      .select({ responseId: surveyResponseSpend.responseId, category: surveyResponseSpend.category, amountKurus: surveyResponseSpend.amountKurus })
      .from(surveyResponseSpend)
      .innerJoin(surveyResponses, eq(surveyResponses.id, surveyResponseSpend.responseId))
      .where(and(eq(surveyResponseSpend.organizationId, organizationId), eq(surveyResponses.eventId, eventId),
        eq(surveyResponses.audience, "ATTENDEE"), eq(surveyResponses.isExcluded, false)))
    : [];
  const spendBy = new Map<string, Partial<Record<SpendCategoryValue, number>>>();
  for (const s of spend) (spendBy.get(s.responseId) ?? spendBy.set(s.responseId, {}).get(s.responseId)!)[s.category] = s.amountKurus;

  const responses: KpiResponse[] = rows.map((r) => {
    const a = r.answers ?? {};
    return {
      weight: Number(r.weight), isLocalResident: r.isLocalResident, homeProvinceCode: r.homeProvinceCode, partySize: r.partySize,
      daysPresent: r.daysPresent, nightsStayed: r.nightsStayed, mainReason: r.mainReason, wouldVisitAnyway: r.wouldVisitAnyway,
      nps: num(a.q_nps, 0, 10), overallSatisfaction: num(a.q_overall_satisfaction, 1, 5), accessibilitySatisfaction: num(a.q_accessibility, 1, 5),
      attendedBefore: typeof a.q_attended_before === "boolean" ? a.q_attended_before : null,
      spendKurus: spendBy.get(r.id) ?? {},
    };
  });

  const lines: FinanceLine[] | null = finance
    ? (await adminDb.select().from(budgetItems).where(and(eq(budgetItems.organizationId, organizationId), eq(budgetItems.eventId, eventId))))
      .map((l) => ({
        kind: l.kind as FinanceLine["kind"], category: l.category, plannedKurus: l.plannedKurus, actualKurus: l.actualKurus, quantity: l.quantity,
        costBehavior: l.costBehavior as FinanceLine["costBehavior"], supplierLocal: l.supplierLocal, fundedExternally: l.fundedExternally,
      }))
    : null;

  const profile = (ev.aiConfig?.event ?? null) as { capacity?: number | null } | null;
  const finished = ev.status === "completed" || (!!(ev.endDate ?? ev.startDate) && (ev.endDate ?? ev.startDate)! < today);
  const values = computeKpis({
    tickets: { valid: t?.valid ?? 0, cancelled: t?.cancelled ?? 0, checkedIn: t?.checkedIn ?? 0, leadDaysSum: Number(t?.leadDaysSum ?? 0), leadDaysN: t?.leadDaysN ?? 0 },
    capacity: typeof profile?.capacity === "number" && profile.capacity > 0 ? profile.capacity : null,
    eventFinished: finished,
    tasks: { dueReached: tk?.dueReached ?? 0, onTime: tk?.onTime ?? 0 },
    responses,
    finance: lines ? { lines } : null,
    external: await loadExternalData(organizationId, eventId),
    datasets: await loadConfirmedDatasets(organizationId, eventId),
  });
  return { engineVersion: KPI_ENGINE_VERSION, catalogVersion: KPI_CATALOG_VERSION, computedAt: new Date().toISOString(), values: [...values.values()] };
}

export interface KpiWithActual {
  id: string;
  metricName: string;
  catalogId: string | null;
  computed: KpiValue | null;
  /** The actual shown: engine value when the metric is computed, otherwise the organizer's manual entry. */
  actual: number | null;
  actualSource: "engine" | "manual" | null;
}

/** Event KPIs joined with the engine's values (catalog id via LIBRARY_TO_CATALOG or the metric name itself). */
export async function eventKpiActuals(organizationId: string, eventId: string, opts: { finance: boolean }): Promise<KpiWithActual[]> {
  const { values } = await eventKpiValues(organizationId, eventId, opts);
  const byId = new Map(values.map((x) => [x.id, x]));
  const kpis = await adminDb
    .select({ id: eventKpis.id, metricName: eventKpis.metricName, actualValue: eventKpis.actualValue })
    .from(eventKpis)
    .where(and(eq(eventKpis.organizationId, organizationId), eq(eventKpis.eventId, eventId)));
  return kpis.map((k) => {
    const catalogId = LIBRARY_TO_CATALOG[k.metricName] ?? (KPI_BY_ID.has(k.metricName) ? k.metricName : null);
    const computed = catalogId ? byId.get(catalogId) ?? null : null;
    const manual = k.actualValue === null ? null : Number(k.actualValue);
    if (computed && computed.value === null && manual !== null && catalogId && allowsManualFallback(catalogId)) {
      return { id: k.id, metricName: k.metricName, catalogId, computed, actual: manual, actualSource: "manual" as const };
    }
    return computed
      ? { id: k.id, metricName: k.metricName, catalogId, computed, actual: computed.value, actualSource: computed.value === null ? null : "engine" }
      : { id: k.id, metricName: k.metricName, catalogId, computed: null, actual: manual, actualSource: manual === null ? null : "manual" };
  });
}
