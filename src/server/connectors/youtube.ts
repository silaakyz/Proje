/**
 * YouTube Data API v3 (YOUTUBE_API_KEY): the configured videos, plus — with a channel id — the channel's videos
 * published in the promotion period (search.list, 100 quota units per call). Statistics from videos.list
 * (part=statistics,snippet; 1 unit per 50 videos). Stored per video: youtube.views, youtube.likes, youtube.comments.
 * likeCount is absent when the owner hides it: counted as 0 (stated in the metric note).
 */
import type { ProviderConfig } from "@/lib/connectors/providers";
import { fetchJson, promotionPeriod, requireEnv, type Connector, type ObservationInput } from "./core";

interface SearchResponse { items?: { id?: { videoId?: string } }[]; nextPageToken?: string }
interface VideosResponse { items?: { id: string; snippet?: { title?: string; publishedAt?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }

const API = "https://www.googleapis.com/youtube/v3";

export const youtubeConnector: Connector<ProviderConfig<"YOUTUBE">> = async (ctx) => {
  const key = requireEnv("YOUTUBE", ctx, "YOUTUBE_API_KEY");
  const ids = new Set(ctx.config.videoIds);
  if (ctx.config.channelId) {
    const { from, to } = promotionPeriod("YOUTUBE", ctx.event, ctx.config, ctx.now);
    let pageToken: string | undefined;
    for (let i = 0; i < 4; i++) {
      const q = new URLSearchParams({
        part: "id", channelId: ctx.config.channelId, type: "video", maxResults: "50", order: "date",
        publishedAfter: `${from}T00:00:00+03:00`, publishedBefore: `${to}T23:59:59+03:00`, key, ...(pageToken ? { pageToken } : {}),
      });
      const r = await fetchJson<SearchResponse>("YOUTUBE", ctx.fetch, `${API}/search?${q}`);
      for (const it of r.items ?? []) if (it.id?.videoId) ids.add(it.id.videoId);
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
  }
  const all = [...ids];
  const observations: ObservationInput[] = [];
  for (let i = 0; i < all.length; i += 50) {
    const q = new URLSearchParams({ part: "statistics,snippet", id: all.slice(i, i + 50).join(","), key });
    const r = await fetchJson<VideosResponse>("YOUTUBE", ctx.fetch, `${API}/videos?${q}`);
    for (const v of r.items ?? []) {
      const at = v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null;
      const n = (s: string | undefined) => Number(s ?? 0) || 0;
      const detail = { title: v.snippet?.title ?? null, likesHidden: v.statistics?.likeCount === undefined };
      observations.push({ key: "youtube.views", dimension: `video:${v.id}`, value: n(v.statistics?.viewCount), observedAt: at, detail });
      observations.push({ key: "youtube.likes", dimension: `video:${v.id}`, value: n(v.statistics?.likeCount), observedAt: at });
      observations.push({ key: "youtube.comments", dimension: `video:${v.id}`, value: n(v.statistics?.commentCount), observedAt: at });
    }
  }
  const found = observations.length / 3;
  return { observations, summary: `${found} video${all.length > found ? ` (${all.length - found} kimlik bulunamadı veya gizli)` : ""}.` };
};
