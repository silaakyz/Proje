/**
 * The organizer's decision on a KPI (event.write): activate or drop an AI-proposed KPI and set its target.
 * Once a KPI is ACTIVE or DROPPED it belongs to the organizer and AI regenerations leave it alone
 * (apply-proposal-drizzle.ts). Moving back to PROPOSED is not offered, so a decision is never handed back
 * to the AI. `actualValue` is a manual entry, accepted only for metrics the KPI engine does not compute
 * (src/lib/kpi/engine.ts computes the rest from the platform's data; a typed number never overrides those).
 * event_kpis has no browser write privilege → server write after the route's permission check, scoped to the
 * caller's organization.
 */
import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { eventKpis } from "@/db/schema";
import { allowsManualFallback, KPI_BY_ID, LIBRARY_TO_CATALOG } from "@/lib/kpi/catalog";
import { ApiError } from "@/server/http";

export const updateKpiSchema = z
  .object({
    organizationId: z.uuid(),
    status: z.enum(["ACTIVE", "DROPPED"]).optional(),
    /** A target the organizer sets; null clears it. Up to 14 integer digits and 4 decimals (numeric(18,4)). */
    targetValue: z.number().finite().gt(-1e14).lt(1e14).nullable().optional(),
    /** Manual actual for a metric the engine does not compute; null clears it. */
    actualValue: z.number().finite().gt(-1e14).lt(1e14).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.targetValue !== undefined || v.actualValue !== undefined, { message: "Nothing to update" });

/** True when the KPI engine computes this metric (then its actual is never typed in). */
export const isEngineComputed = (metricName: string) => {
  const id = LIBRARY_TO_CATALOG[metricName] ?? metricName;
  return !!KPI_BY_ID.get(id)?.computable;
};

export async function updateKpi(kpiId: string, input: z.infer<typeof updateKpiSchema>) {
  const set: Partial<typeof eventKpis.$inferInsert> = { updatedAt: new Date() };
  if (input.status !== undefined) set.status = input.status;
  if (input.targetValue !== undefined) set.targetValue = input.targetValue === null ? null : String(input.targetValue);
  if (input.actualValue !== undefined) {
    const [k] = await adminDb.select({ metricName: eventKpis.metricName }).from(eventKpis)
      .where(and(eq(eventKpis.id, kpiId), eq(eventKpis.organizationId, input.organizationId))).limit(1);
    if (!k) throw new ApiError(404, "KPI not found");
    if (isEngineComputed(k.metricName) && !allowsManualFallback(LIBRARY_TO_CATALOG[k.metricName] ?? k.metricName)) {
      throw new ApiError(422, "This KPI is computed from the platform's data", "KPI_COMPUTED");
    }
    set.actualValue = input.actualValue === null ? null : String(input.actualValue);
  }
  const [row] = await adminDb
    .update(eventKpis)
    .set(set)
    .where(and(eq(eventKpis.id, kpiId), eq(eventKpis.organizationId, input.organizationId)))
    .returning({
      id: eventKpis.id, eventId: eventKpis.eventId, metricName: eventKpis.metricName, status: eventKpis.status,
      targetValue: eventKpis.targetValue, actualValue: eventKpis.actualValue, dataSource: eventKpis.dataSource, updatedAt: eventKpis.updatedAt,
    });
  if (!row) throw new ApiError(404, "KPI not found");
  return row;
}
