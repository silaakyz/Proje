/** Loads an event's external data for the KPI engine (src/lib/kpi/external.ts). Server-only; organization-scoped. */
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { adminDb } from "@/db";
import { dataObservations, eventDataSources, eventLeads, eventSponsors, mediaMentions } from "@/db/schema";
import type { Provider } from "@/lib/connectors/providers";
import type { ExternalData } from "@/lib/kpi/external";

export async function loadExternalData(organizationId: string, eventId: string): Promise<ExternalData> {
  const [sources, observations, mentionCounts, sponsors, leads] = await Promise.all([
    adminDb.select({ id: eventDataSources.id, provider: eventDataSources.provider, enabled: eventDataSources.enabled,
      lastSyncAt: eventDataSources.lastSyncAt, lastStatus: eventDataSources.lastStatus })
      .from(eventDataSources)
      .where(and(eq(eventDataSources.organizationId, organizationId), eq(eventDataSources.eventId, eventId))),
    adminDb.select({ sourceId: dataObservations.sourceId, key: dataObservations.key, dimension: dataObservations.dimension,
      value: dataObservations.value, observedAt: dataObservations.observedAt })
      .from(dataObservations)
      .where(and(eq(dataObservations.organizationId, organizationId), eq(dataObservations.eventId, eventId))),
    adminDb.select({
      verified: sql<number>`count(*) filter (where ${mediaMentions.status} = 'VERIFIED')::int`,
      candidates: sql<number>`count(*) filter (where ${mediaMentions.status} = 'CANDIDATE')::int`,
    }).from(mediaMentions).where(and(eq(mediaMentions.organizationId, organizationId), eq(mediaMentions.eventId, eventId))),
    adminDb.select().from(eventSponsors).where(and(eq(eventSponsors.organizationId, organizationId), eq(eventSponsors.eventId, eventId))),
    adminDb.select().from(eventLeads).where(and(eq(eventLeads.organizationId, organizationId), eq(eventLeads.eventId, eventId))),
  ]);
  // A disabled source keeps its history but no longer feeds the metrics.
  const active = new Map(sources.filter((s) => s.enabled).map((s) => [s.id, s.provider as Provider]));
  return {
    sources: sources.filter((s) => s.enabled).map((s) => ({
      provider: s.provider as Provider, lastSyncAt: s.lastSyncAt?.toISOString() ?? null, lastStatus: s.lastStatus,
    })),
    observations: observations.filter((o) => active.has(o.sourceId)).map((o) => ({
      provider: active.get(o.sourceId)!, key: o.key, dimension: o.dimension, value: o.value, observedAt: o.observedAt?.toISOString() ?? null,
    })),
    mentions: { verified: Number(mentionCounts[0]?.verified ?? 0), candidates: Number(mentionCounts[0]?.candidates ?? 0) },
    sponsors: sponsors.map((s) => ({
      currentEdition: s.currentEdition, previousEdition: s.previousEdition, costKurus: s.costKurus, attributedValueKurus: s.attributedValueKurus,
      impressions: s.impressions,
    })),
    leads: leads.map((l) => ({
      exhibitor: l.exhibitor, consent: l.consent, qualified: l.qualified, opportunity: l.opportunity,
      opportunityValueKurus: l.opportunityValueKurus, wonRevenueKurus: l.wonRevenueKurus, boothMinutes: l.boothMinutes,
    })),
    leadProgramCostKurus: null, // filled by the engine from the budget lines (finance access)
  };
}
