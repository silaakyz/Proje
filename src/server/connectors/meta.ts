/**
 * Instagram and Facebook from the Meta Graph API (META_ACCESS_TOKEN; version META_GRAPH_VERSION, default v25.0).
 *
 *   Instagram posts   GET /{ig-user}/media?fields=id,timestamp,permalink → GET /{media}/insights?metric=reach,total_interactions
 *   Facebook posts    GET /{page}/posts?fields=…,shares,reactions.summary,comments.summary&since&until
 *                     → GET /{post}/insights?metric=post_total_media_view_unique  (Meta's replacement for the removed
 *                     post_impressions_unique; interactions = reactions + comments + shares)
 *   Mentions          GET /ig_hashtag_search?user_id&q → GET /{hashtag}/recent_media?user_id&fields=id,timestamp
 *                     (the last 24 hours only: mentions accumulate across pulls; Meta allows 30 hashtags a week)
 *
 * Stored: social.reach, social.interactions (dimension instagram:<id> / facebook:<id>), social.mention
 * (instagram:<media id>, value 1). Only posts inside the promotion period.
 */
import type { ProviderConfig } from "@/lib/connectors/providers";
import { ConnectorError, fetchJson, promotionPeriod, requireEnv, type Connector, type ObservationInput } from "./core";

interface Page<T> { data?: T[]; paging?: { next?: string } }
interface Insight { name: string; values?: { value: number }[]; total_value?: { value: number } }
interface IgMedia { id: string; timestamp?: string; permalink?: string }
interface FbPost { id: string; created_time?: string; permalink_url?: string; shares?: { count?: number };
  reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }

const MAX_PAGES = 10;
const toDate = (s: string | undefined) => (s ? new Date(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : null);
const metric = (data: Insight[] | undefined, name: string) => {
  const m = data?.find((d) => d.name === name);
  return Number(m?.total_value?.value ?? m?.values?.[0]?.value ?? 0) || 0;
};

export const metaConnector: Connector<ProviderConfig<"META">> = async (ctx) => {
  const token = requireEnv("META", ctx, "META_ACCESS_TOKEN");
  const version = ctx.env("META_GRAPH_VERSION")?.trim() || "v25.0";
  if (!/^v\d{1,3}\.\d$/.test(version)) throw new ConnectorError("META", "META_GRAPH_VERSION geçersiz (örn. v25.0).");
  const base = `https://graph.facebook.com/${version}`;
  const { from, to } = promotionPeriod("META", ctx.event, ctx.config, ctx.now);
  const fromT = new Date(`${from}T00:00:00+03:00`), toT = new Date(`${to}T23:59:59+03:00`);
  const inPeriod = (d: Date | null) => !!d && d >= fromT && d <= toT;
  const get = <T>(path: string, q: Record<string, string> = {}) =>
    fetchJson<T>("META", ctx.fetch, path.startsWith("https://") ? path : `${base}/${path}?${new URLSearchParams({ ...q, access_token: token })}`);

  const observations: ObservationInput[] = [];
  const notes: string[] = [];
  let skipped = 0;

  if (ctx.config.instagramUserId) {
    let url: string | undefined;
    let page = await get<Page<IgMedia>>(`${ctx.config.instagramUserId}/media`, { fields: "id,timestamp,permalink", limit: "50" });
    let n = 0;
    for (let i = 0; i < MAX_PAGES; i++) {
      const items = page.data ?? [];
      for (const m of items) {
        const at = toDate(m.timestamp);
        if (!inPeriod(at)) continue;
        try {
          const ins = await get<Page<Insight>>(`${m.id}/insights`, { metric: "reach,total_interactions" });
          observations.push({ key: "social.reach", dimension: `instagram:${m.id}`, value: metric(ins.data, "reach"), observedAt: at, detail: { permalink: m.permalink ?? null } });
          observations.push({ key: "social.interactions", dimension: `instagram:${m.id}`, value: metric(ins.data, "total_interactions"), observedAt: at });
          n++;
        } catch {
          skipped++; // e.g. a media type without these insights
        }
      }
      const oldest = toDate(items.at(-1)?.timestamp);
      url = page.paging?.next;
      if (!url || (oldest && oldest < fromT)) break;
      page = await get<Page<IgMedia>>(url);
    }
    notes.push(`Instagram: ${n} gönderi`);

    for (const tag of ctx.config.hashtags) {
      const h = await get<Page<{ id: string }>>("ig_hashtag_search", { user_id: ctx.config.instagramUserId, q: tag });
      const hid = h.data?.[0]?.id;
      if (!hid) continue;
      const recent = await get<Page<IgMedia>>(`${hid}/recent_media`, { user_id: ctx.config.instagramUserId, fields: "id,timestamp,permalink", limit: "50" });
      let k = 0;
      for (const m of recent.data ?? []) {
        const at = toDate(m.timestamp);
        if (!inPeriod(at)) continue;
        observations.push({ key: "social.mention", dimension: `instagram:${m.id}`, value: 1, observedAt: at, detail: { hashtag: tag, permalink: m.permalink ?? null } });
        k++;
      }
      notes.push(`#${tag}: ${k} yeni/güncel gönderi`);
    }
  }

  if (ctx.config.facebookPageId) {
    const since = String(Math.floor(fromT.getTime() / 1000)), until = String(Math.floor(toT.getTime() / 1000));
    let page = await get<Page<FbPost>>(`${ctx.config.facebookPageId}/posts`, {
      fields: "id,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
      since, until, limit: "50",
    });
    let n = 0;
    for (let i = 0; i < MAX_PAGES; i++) {
      for (const p of page.data ?? []) {
        const at = toDate(p.created_time);
        if (!inPeriod(at)) continue;
        const interactions = (p.reactions?.summary?.total_count ?? 0) + (p.comments?.summary?.total_count ?? 0) + (p.shares?.count ?? 0);
        let reach = 0;
        try {
          const ins = await get<Page<Insight>>(`${p.id}/insights`, { metric: "post_total_media_view_unique" });
          reach = metric(ins.data, "post_total_media_view_unique");
        } catch {
          skipped++;
          continue;
        }
        observations.push({ key: "social.reach", dimension: `facebook:${p.id}`, value: reach, observedAt: at, detail: { permalink: p.permalink_url ?? null } });
        observations.push({ key: "social.interactions", dimension: `facebook:${p.id}`, value: interactions, observedAt: at });
        n++;
      }
      if (!page.paging?.next) break;
      page = await get<Page<FbPost>>(page.paging.next);
    }
    notes.push(`Facebook: ${n} gönderi`);
  }
  if (skipped) notes.push(`${skipped} gönderinin istatistiği alınamadı`);
  return { observations, summary: `${from} – ${to}. ${notes.join("; ")}.` };
};
