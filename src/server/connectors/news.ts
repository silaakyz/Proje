/**
 * Press-mention candidates for the event (no key): exact-phrase search of the terms (default: the event title) in
 *   GDELT DOC 2.0   https://api.gdeltproject.org/api/v2/doc/doc?query=…&mode=ArtList&format=json  (last 3 months;
 *                   at most one request every 5 seconds)
 *   Google News     https://news.google.com/rss/search?q=…&hl=tr&gl=TR&ceid=TR:tr  (RSS)
 * Candidates are stored as media_mentions (CANDIDATE); a person verifies them before they count. One source failing
 * does not lose the other's results.
 */
import type { ProviderConfig } from "@/lib/connectors/providers";
import { addDays, ConnectorError, fetchJson, maskUrl, promotionPeriod, todayIstanbul, type Connector, type MentionInput } from "./core";

interface GdeltResponse { articles?: { url?: string; title?: string; seendate?: string; domain?: string }[] }

const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&")
  .trim();
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1];
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Parses a Google News RSS feed into mentions (title, link, pubDate, <source url>). */
export function parseNewsRss(xml: string): MentionInput[] {
  const out: MentionInput[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]!;
    const link = decode(tag(item, "link") ?? "");
    if (!/^https?:\/\//.test(link)) continue;
    const sourceUrl = item.match(/<source[^>]*url="([^"]+)"/)?.[1];
    const pub = tag(item, "pubDate");
    const date = pub ? new Date(decode(pub)) : null;
    out.push({ url: link, title: decode(tag(item, "title") ?? "") || null, domain: sourceUrl ? host(decode(sourceUrl)) : host(link),
      publishedAt: date && !Number.isNaN(date.getTime()) ? date : null, foundBy: "GOOGLE_NEWS" });
  }
  return out;
}

const gdeltDate = (s: string | undefined) => {
  const m = s?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : null;
};

export const newsConnector: Connector<ProviderConfig<"NEWS">> = async (ctx) => {
  const terms = ctx.config.terms.length ? ctx.config.terms : [ctx.event.title];
  const { from, to } = promotionPeriod("NEWS", ctx.event, ctx.config, ctx.now);
  const phrase = (t: string) => `"${t.replace(/"/g, "")}"`;
  const mentions: MentionInput[] = [];
  const notes: string[] = [];
  const errors: string[] = [];

  // GDELT: the API covers about the last 3 months.
  const gFrom = from < addDays(todayIstanbul(ctx.now), -89) ? addDays(todayIstanbul(ctx.now), -89) : from;
  if (gFrom <= to) {
    const q = new URLSearchParams({
      query: terms.length > 1 ? `(${terms.map(phrase).join(" OR ")})` : phrase(terms[0]!),
      mode: "ArtList", format: "json", maxrecords: "250", sort: "DateDesc",
      startdatetime: `${gFrom.replace(/-/g, "")}000000`, enddatetime: `${to.replace(/-/g, "")}235959`,
    });
    try {
      const r = await fetchJson<GdeltResponse>("NEWS", ctx.fetch, `https://api.gdeltproject.org/api/v2/doc/doc?${q}`);
      let n = 0;
      for (const a of r.articles ?? []) {
        if (!a.url || !/^https?:\/\//.test(a.url)) continue;
        mentions.push({ url: a.url, title: a.title ?? null, domain: a.domain ?? host(a.url), publishedAt: gdeltDate(a.seendate), foundBy: "GDELT" });
        n++;
      }
      notes.push(`GDELT ${n}`);
    } catch (e) {
      errors.push(`GDELT: ${(e as Error).message}`);
    }
  }

  // Google News RSS, one query per term.
  for (const t of terms) {
    const url = `https://news.google.com/rss/search?${new URLSearchParams({ q: `${phrase(t)} after:${addDays(from, -1)} before:${addDays(to, 1)}`, hl: "tr", gl: "TR", ceid: "TR:tr" })}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await ctx.fetch(url, { signal: ctrl.signal, headers: { accept: "application/rss+xml, application/xml" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseNewsRss(await res.text());
      mentions.push(...items);
      notes.push(`Google News "${t}" ${items.length}`);
    } catch (e) {
      errors.push(`Google News: ${maskUrl((e as Error).message)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!notes.length && errors.length) throw new ConnectorError("NEWS", errors.join(" · "));
  // the same article found by both sources counts once (by URL)
  const unique = [...new Map(mentions.map((m) => [m.url, m])).values()];
  return { observations: [], mentions: unique, summary: `${from} – ${to}: ${notes.join(", ")} aday${errors.length ? `; hata: ${errors.join(" · ")}` : ""}.` };
};
