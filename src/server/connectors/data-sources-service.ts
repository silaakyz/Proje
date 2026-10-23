/**
 * Event data sources (src/lib/connectors/providers.ts): configuration, pulls, press-mention review and sponsor /
 * lead uploads. Server-only; every query is scoped to the caller's organization. Routes check permissions:
 * org.read (status), data.manage (configure, pull, review, upload; owner/admin).
 *
 * A pull runs the provider's connector with the server's credentials (environment), then upserts its
 * observations and inserts new press candidates in one transaction; the source records OK / ERROR with a message
 * that never contains a credential.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { dataObservations, eventDataSources, eventLeads, events, eventSponsors, mediaMentions } from "@/db/schema";
import { MENTION_STATUSES, PROVIDER_CONFIG, PROVIDER_INFO, PROVIDERS, SYNC_WINDOW, type Provider } from "@/lib/connectors/providers";
import { parseLeadsCsv, parseSponsorsCsv } from "@/lib/connectors/csv";
import type { OrgAccess } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";
import { airConnector } from "./air";
import { brevoConnector } from "./brevo";
import { ConnectorError, scrub, type Connector, type ConnectorEvent } from "./core";
import { ga4Connector } from "./ga4";
import { metaConnector } from "./meta";
import { newsConnector } from "./news";
import { youtubeConnector } from "./youtube";

const CONNECTORS: Record<Provider, Connector<never>> = {
  OPEN_METEO_AIR: airConnector as Connector<never>,
  BREVO: brevoConnector as Connector<never>,
  GA4: ga4Connector as Connector<never>,
  META: metaConnector as Connector<never>,
  YOUTUBE: youtubeConnector as Connector<never>,
  NEWS: newsConnector as Connector<never>,
};

const env = (name: string) => process.env[name];
const secrets = () => PROVIDERS.flatMap((p) => PROVIDER_INFO[p].envKeys).map(env);

// ------------------------------------------------------------------------------------------- read

async function eventOf(organizationId: string, eventId: string): Promise<ConnectorEvent> {
  const [ev] = await adminDb.select({ id: events.id, title: events.title, startDate: events.startDate, endDate: events.endDate, aiConfig: events.aiConfig })
    .from(events).where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  const p = (ev.aiConfig?.event ?? null) as { city?: unknown; dailyStartTime?: unknown; dailyEndTime?: unknown } | null;
  const hm = (v: unknown) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null);
  return {
    id: ev.id, title: ev.title, startDate: ev.startDate, endDate: ev.endDate,
    city: typeof p?.city === "string" && p.city.trim() ? p.city.trim() : null, dailyStartTime: hm(p?.dailyStartTime), dailyEndTime: hm(p?.dailyEndTime),
  };
}

/** Sources of an event, every provider listed (configured or not) with whether the server has its credentials. */
export async function listDataSources(organizationId: string, eventId: string) {
  const ev = await eventOf(organizationId, eventId);
  const rows = await adminDb.select().from(eventDataSources)
    .where(and(eq(eventDataSources.organizationId, organizationId), eq(eventDataSources.eventId, eventId)));
  const counts = await adminDb.select({ sourceId: dataObservations.sourceId, n: sql<number>`count(*)::int` }).from(dataObservations)
    .where(and(eq(dataObservations.organizationId, organizationId), eq(dataObservations.eventId, eventId))).groupBy(dataObservations.sourceId);
  return {
    event: { city: ev.city, startDate: ev.startDate, endDate: ev.endDate, title: ev.title },
    providers: PROVIDERS.map((provider) => {
      const info = PROVIDER_INFO[provider];
      const row = rows.find((r) => r.provider === provider);
      return {
        provider, label: info.label, feeds: info.feeds, terms: info.terms, docs: info.docs,
        envKeys: info.envKeys, missingEnv: info.envKeys.filter((k) => !env(k)?.trim()),
        source: row ? {
          id: row.id, config: row.config, enabled: row.enabled, lastSyncAt: row.lastSyncAt, lastStatus: row.lastStatus,
          lastError: row.lastError, lastSummary: row.lastSummary, observations: counts.find((c) => c.sourceId === row.id)?.n ?? 0,
        } : null,
      };
    }),
  };
}

// ------------------------------------------------------------------------------------------- configure

export const saveSourceSchema = z.object({
  organizationId: z.uuid(),
  provider: z.enum(PROVIDERS),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().default(true),
});

export async function saveDataSource(access: OrgAccess, eventId: string, input: z.infer<typeof saveSourceSchema>) {
  await eventOf(access.organizationId, eventId);
  const parsed = PROVIDER_CONFIG[input.provider].safeParse(input.config);
  if (!parsed.success) throw parsed.error;
  const config = parsed.data as Record<string, unknown>;
  return adminDb.transaction(async (tx) => {
    const [cur] = await tx.select().from(eventDataSources)
      .where(and(eq(eventDataSources.organizationId, access.organizationId), eq(eventDataSources.eventId, eventId), eq(eventDataSources.provider, input.provider)))
      .limit(1);
    if (!cur) {
      const [row] = await tx.insert(eventDataSources).values({
        organizationId: access.organizationId, eventId, provider: input.provider, config, enabled: input.enabled, createdBy: access.userId,
      }).returning();
      return row!;
    }
    const changed = JSON.stringify(cur.config) !== JSON.stringify(config);
    // New settings read different things: what the old ones produced no longer describes this source.
    if (changed) await tx.delete(dataObservations).where(and(eq(dataObservations.sourceId, cur.id), eq(dataObservations.organizationId, access.organizationId)));
    const [row] = await tx.update(eventDataSources).set({
      config, enabled: input.enabled, updatedAt: new Date(),
      ...(changed ? { lastSyncAt: null, lastStatus: null, lastError: null, lastSummary: null } : {}),
    }).where(and(eq(eventDataSources.id, cur.id), eq(eventDataSources.organizationId, access.organizationId))).returning();
    return row!;
  });
}

export async function deleteDataSource(organizationId: string, sourceId: string) {
  const [row] = await adminDb.delete(eventDataSources)
    .where(and(eq(eventDataSources.id, sourceId), eq(eventDataSources.organizationId, organizationId))).returning({ id: eventDataSources.id });
  if (!row) throw new ApiError(404, "Data source not found");
}

// ------------------------------------------------------------------------------------------- pull

export interface PullOptions { fetch?: typeof fetch; now?: Date; env?: (name: string) => string | undefined; readFile?: (p: string) => Promise<string> }

/** Runs one source's connector and stores what it returned. Never throws for a provider failure: records it. */
export async function pullSource(organizationId: string, sourceId: string, opts: PullOptions = {}) {
  const [src] = await adminDb.select().from(eventDataSources)
    .where(and(eq(eventDataSources.id, sourceId), eq(eventDataSources.organizationId, organizationId))).limit(1);
  if (!src) throw new ApiError(404, "Data source not found");
  const provider = src.provider as Provider;
  const event = await eventOf(organizationId, src.eventId);
  const now = opts.now ?? new Date();
  try {
    const config = PROVIDER_CONFIG[provider].parse(src.config);
    const result = await CONNECTORS[provider]({
      event, config: config as never, now,
      fetch: opts.fetch ?? fetch, env: opts.env ?? env, readFile: opts.readFile ?? ((p) => readFile(p, "utf8")),
    });
    await adminDb.transaction(async (tx) => {
      const obs = result.observations.filter((o) => Number.isFinite(o.value));
      for (let i = 0; i < obs.length; i += 500) {
        await tx.insert(dataObservations).values(obs.slice(i, i + 500).map((o) => ({
          organizationId, eventId: src.eventId, sourceId: src.id, key: o.key.slice(0, 64), dimension: o.dimension.slice(0, 200), value: o.value,
          observedAt: o.observedAt ?? null, detail: o.detail ?? null, fetchedAt: now,
        }))).onConflictDoUpdate({
          target: [dataObservations.sourceId, dataObservations.key, dataObservations.dimension],
          set: { value: sql`excluded.value`, observedAt: sql`excluded.observed_at`, detail: sql`excluded.detail`, fetchedAt: sql`excluded.fetched_at` },
        });
      }
      const mentions = (result.mentions ?? []).filter((m) => /^https?:\/\//.test(m.url) && m.url.length <= 2000);
      for (let i = 0; i < mentions.length; i += 200) {
        await tx.insert(mediaMentions).values(mentions.slice(i, i + 200).map((m) => ({
          organizationId, eventId: src.eventId, url: m.url, title: m.title?.slice(0, 500) ?? null, domain: m.domain?.slice(0, 255) ?? null,
          publishedAt: m.publishedAt && !Number.isNaN(m.publishedAt.getTime()) ? m.publishedAt : null, foundBy: m.foundBy,
        }))).onConflictDoNothing({ target: [mediaMentions.eventId, mediaMentions.url] }); // keeps a person's review
      }
      await tx.update(eventDataSources).set({ lastSyncAt: now, lastStatus: "OK", lastError: null, lastSummary: result.summary.slice(0, 1000) })
        .where(and(eq(eventDataSources.id, src.id), eq(eventDataSources.organizationId, organizationId)));
    });
    return { provider, status: "OK" as const, summary: result.summary };
  } catch (e) {
    const message = e instanceof ConnectorError ? e.message
      : e instanceof z.ZodError ? "Kaynak ayarı geçersiz; ayarı yeniden kaydedin."
      : `Beklenmeyen hata: ${(e as Error).message}`;
    const safe = scrub(message, secrets());
    await adminDb.update(eventDataSources).set({ lastSyncAt: now, lastStatus: "ERROR", lastError: safe })
      .where(and(eq(eventDataSources.id, src.id), eq(eventDataSources.organizationId, organizationId)));
    return { provider, status: "ERROR" as const, error: safe };
  }
}

export const pullSchema = z.object({ organizationId: z.uuid(), provider: z.enum(PROVIDERS).optional() });

/** Pulls one provider's source of an event now (manual "Şimdi çek"). */
export async function pullProvider(organizationId: string, eventId: string, provider: Provider, opts: PullOptions = {}) {
  await eventOf(organizationId, eventId);
  const [row] = await adminDb.select({ id: eventDataSources.id }).from(eventDataSources)
    .where(and(eq(eventDataSources.organizationId, organizationId), eq(eventDataSources.eventId, eventId), eq(eventDataSources.provider, provider))).limit(1);
  if (!row) throw new ApiError(404, "Data source not found");
  return pullSource(organizationId, row.id, opts);
}

/** Pulls every enabled source of an event, one after another (providers rate-limit). */
export async function pullEvent(organizationId: string, eventId: string, opts: PullOptions = {}) {
  await eventOf(organizationId, eventId);
  const rows = await adminDb.select({ id: eventDataSources.id }).from(eventDataSources)
    .where(and(eq(eventDataSources.organizationId, organizationId), eq(eventDataSources.eventId, eventId), eq(eventDataSources.enabled, true)))
    .orderBy(asc(eventDataSources.provider));
  const results = [];
  for (const r of rows) results.push(await pullSource(organizationId, r.id, opts));
  return results;
}

/**
 * Automatic pulls: claims the enabled sources that are due (never pulled, or not within `intervalMinutes`) of events
 * inside their window (SYNC_WINDOW days around the event dates) by stamping last_sync_at in the same statement
 * (FOR UPDATE SKIP LOCKED), so two processes never pull the same source; then pulls them.
 */
export async function pullDueSources(intervalMinutes: number, opts: PullOptions & { limit?: number } = {}) {
  const claimed = await adminDb.execute<{ id: string; organization_id: string }>(sql`
    update event_data_sources s set last_sync_at = now()
    where s.id in (
      select d.id from event_data_sources d join events e on e.id = d.event_id and e.organization_id = d.organization_id
      where d.enabled and e.archived_at is null and e.start_date is not null
        and (d.last_sync_at is null or d.last_sync_at < now() - make_interval(mins => ${intervalMinutes}))
        and (now() at time zone 'Europe/Istanbul')::date between e.start_date - ${SYNC_WINDOW.daysBefore}::int
          and coalesce(e.end_date, e.start_date) + ${SYNC_WINDOW.daysAfter}::int
      order by d.last_sync_at nulls first
      limit ${opts.limit ?? 20}
      for update of d skip locked)
    returning s.id, s.organization_id`);
  const rows = (Array.isArray(claimed) ? claimed : (claimed as { rows: { id: string; organization_id: string }[] }).rows);
  const results = [];
  for (const r of rows) results.push(await pullSource(r.organization_id, r.id, opts));
  return results;
}

// ------------------------------------------------------------------------------------------- press mentions

export async function listMentions(organizationId: string, eventId: string) {
  await eventOf(organizationId, eventId);
  return adminDb.select({
    id: mediaMentions.id, url: mediaMentions.url, title: mediaMentions.title, domain: mediaMentions.domain, publishedAt: mediaMentions.publishedAt,
    foundBy: mediaMentions.foundBy, status: mediaMentions.status, reviewedAt: mediaMentions.reviewedAt,
  }).from(mediaMentions)
    .where(and(eq(mediaMentions.organizationId, organizationId), eq(mediaMentions.eventId, eventId)))
    .orderBy(sql`case ${mediaMentions.status} when 'CANDIDATE' then 0 when 'VERIFIED' then 1 else 2 end`, desc(mediaMentions.publishedAt), asc(mediaMentions.id))
    .limit(500);
}

export const reviewMentionSchema = z.object({ organizationId: z.uuid(), status: z.enum(MENTION_STATUSES) });
export const addMentionSchema = z.object({
  organizationId: z.uuid(),
  url: z.url({ protocol: /^https?$/ }).max(2000),
  title: z.string().trim().max(500).nullable().default(null),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});

export async function reviewMention(access: OrgAccess, mentionId: string, status: (typeof MENTION_STATUSES)[number]) {
  const reviewed = status !== "CANDIDATE";
  const [row] = await adminDb.update(mediaMentions).set({
    status, reviewedBy: reviewed ? access.userId : null, reviewedAt: reviewed ? new Date() : null, updatedAt: new Date(),
  }).where(and(eq(mediaMentions.id, mentionId), eq(mediaMentions.organizationId, access.organizationId))).returning({ id: mediaMentions.id, status: mediaMentions.status });
  if (!row) throw new ApiError(404, "Mention not found");
  return row;
}

/** A clipping the organizer found themselves: stored as VERIFIED (a person added it). */
export async function addManualMention(access: OrgAccess, eventId: string, input: z.infer<typeof addMentionSchema>) {
  await eventOf(access.organizationId, eventId);
  let domain: string | null = null;
  try {
    domain = new URL(input.url).hostname.replace(/^www\./, "");
  } catch { /* validated above */ }
  const [row] = await adminDb.insert(mediaMentions).values({
    organizationId: access.organizationId, eventId, url: input.url, title: input.title, domain,
    publishedAt: input.publishedAt ? new Date(`${input.publishedAt}T12:00:00+03:00`) : null,
    foundBy: "MANUAL", status: "VERIFIED", reviewedBy: access.userId, reviewedAt: new Date(),
  }).onConflictDoNothing({ target: [mediaMentions.eventId, mediaMentions.url] }).returning({ id: mediaMentions.id });
  if (!row) throw new ApiError(409, "This link is already listed", "MENTION_EXISTS");
  return row;
}

// ------------------------------------------------------------------------------------------- CSV uploads

export const uploadCsvSchema = z.object({ organizationId: z.uuid(), csv: z.string().min(1).max(2_000_000) });

/** Replaces the event's sponsor list with the uploaded one (all-or-nothing). */
export async function uploadSponsors(organizationId: string, eventId: string, csv: string) {
  await eventOf(organizationId, eventId);
  const parsed = parseSponsorsCsv(csv);
  if (parsed.issues.length) return { stored: 0, ...parsed, rows: undefined };
  await adminDb.transaction(async (tx) => {
    await tx.delete(eventSponsors).where(and(eq(eventSponsors.organizationId, organizationId), eq(eventSponsors.eventId, eventId)));
    if (parsed.rows.length) await tx.insert(eventSponsors).values(parsed.rows.map((r) => ({ organizationId, eventId, ...r })));
  });
  return { stored: parsed.rows.length, issues: [], droppedColumns: parsed.droppedColumns, unknownColumns: parsed.unknownColumns };
}

/** Replaces the event's lead list with the uploaded one (all-or-nothing; personal columns are dropped). */
export async function uploadLeads(organizationId: string, eventId: string, csv: string) {
  await eventOf(organizationId, eventId);
  const parsed = parseLeadsCsv(csv);
  if (parsed.issues.length) return { stored: 0, ...parsed, rows: undefined };
  await adminDb.transaction(async (tx) => {
    await tx.delete(eventLeads).where(and(eq(eventLeads.organizationId, organizationId), eq(eventLeads.eventId, eventId)));
    for (let i = 0; i < parsed.rows.length; i += 500) {
      await tx.insert(eventLeads).values(parsed.rows.slice(i, i + 500).map((r) => ({
        organizationId, eventId, ...r, capturedAt: r.capturedAt ? new Date(`${r.capturedAt}T12:00:00+03:00`) : null,
      })));
    }
  });
  return { stored: parsed.rows.length, issues: [], droppedColumns: parsed.droppedColumns, unknownColumns: parsed.unknownColumns };
}

/** Counts for the page (no row-level content: lead lists stay on the server). */
export async function uploadSummary(organizationId: string, eventId: string) {
  await eventOf(organizationId, eventId);
  const [s] = await adminDb.select({ n: sql<number>`count(*)::int`, current: sql<number>`count(*) filter (where ${eventSponsors.currentEdition})::int`,
    updatedAt: sql<string | null>`max(${eventSponsors.createdAt})` })
    .from(eventSponsors).where(and(eq(eventSponsors.organizationId, organizationId), eq(eventSponsors.eventId, eventId)));
  const [l] = await adminDb.select({ n: sql<number>`count(*)::int`, exhibitors: sql<number>`count(distinct ${eventLeads.exhibitor})::int`,
    updatedAt: sql<string | null>`max(${eventLeads.createdAt})` })
    .from(eventLeads).where(and(eq(eventLeads.organizationId, organizationId), eq(eventLeads.eventId, eventId)));
  return {
    sponsors: { rows: Number(s?.n ?? 0), currentEdition: Number(s?.current ?? 0), uploadedAt: s?.updatedAt ?? null },
    leads: { rows: Number(l?.n ?? 0), exhibitors: Number(l?.exhibitors ?? 0), uploadedAt: l?.updatedAt ?? null },
  };
}

export async function clearUpload(organizationId: string, eventId: string, kind: "sponsors" | "leads") {
  await eventOf(organizationId, eventId);
  const t = kind === "sponsors" ? eventSponsors : eventLeads;
  await adminDb.delete(t).where(and(eq(t.organizationId, organizationId), eq(t.eventId, eventId)));
}
