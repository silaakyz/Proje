/**
 * Connectors against recorded responses in each provider's documented format (no network): the requests they make,
 * what they store, and that no credential leaks into an error.
 */
import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROVIDER_CONFIG } from "@/lib/connectors/providers";
import { airConnector } from "../air";
import { brevoConnector } from "../brevo";
import { ConnectorError, scrub, type ConnectorContext, type ConnectorEvent } from "../core";
import { ga4Connector } from "../ga4";
import { metaConnector } from "../meta";
import { newsConnector, parseNewsRss } from "../news";
import { youtubeConnector } from "../youtube";

const EVENT: ConnectorEvent = {
  id: "e", title: "Kordon Gastronomi Festivali", startDate: "2026-10-20", endDate: "2026-10-21", city: "İzmir",
  dailyStartTime: "12:00", dailyEndTime: "14:00",
};
const NOW = new Date("2026-10-25T09:00:00Z");

type Route = (url: URL, init?: RequestInit) => unknown;
function fakeFetch(route: Route) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const body = route(url, init);
    if (body instanceof Response) return body;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}
const ctx = <C,>(config: C, f: typeof fetch, env: Record<string, string> = {}, files: Record<string, string> = {}): ConnectorContext<C> => ({
  event: EVENT, config, fetch: f, env: (n) => env[n], now: NOW, readFile: async (p) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p]!;
  },
});

describe("Open-Meteo air quality", () => {
  it("geocodes the city, asks for the event days and keeps only the event hours", async () => {
    const { f, calls } = fakeFetch((u) => u.hostname.startsWith("geocoding")
      ? { results: [{ name: "İzmir", latitude: 38.41, longitude: 27.13, country_code: "TR", admin1: "İzmir" }] }
      : { hourly: { time: ["2026-10-20T11:00", "2026-10-20T12:00", "2026-10-20T13:00", "2026-10-20T14:00"],
        pm2_5: [3, 4, 20, 9], pm10: [10, 12, 30, null], ozone: [50, 55, 60, 61], nitrogen_dioxide: [5, 6, 7, 8], sulphur_dioxide: [1, 1, 1, 1] } });
    const r = await airConnector(ctx(PROVIDER_CONFIG.OPEN_METEO_AIR.parse({}), f));
    const air = calls[1]!.url;
    expect(air.origin + air.pathname).toBe("https://air-quality-api.open-meteo.com/v1/air-quality");
    expect(Object.fromEntries(air.searchParams)).toMatchObject({ latitude: "38.41", longitude: "27.13", start_date: "2026-10-20", end_date: "2026-10-21",
      timezone: "Europe/Istanbul", hourly: "pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide" });
    // 12:00 and 13:00 only (daily 12:00–14:00)
    expect(new Set(r.observations.map((o) => o.dimension))).toEqual(new Set(["2026-10-20T12:00", "2026-10-20T13:00"]));
    expect(r.observations.find((o) => o.key === "air.pm2_5" && o.dimension === "2026-10-20T13:00")!.value).toBe(20);
  });

  it("refuses a future event and an event without a location", async () => {
    const { f } = fakeFetch(() => ({}));
    const future = { ...ctx(PROVIDER_CONFIG.OPEN_METEO_AIR.parse({}), f), event: { ...EVENT, startDate: "2027-01-01", endDate: null } };
    await expect(airConnector(future)).rejects.toThrow(/henüz başlamadı/);
    const nowhere = { ...ctx(PROVIDER_CONFIG.OPEN_METEO_AIR.parse({}), f), event: { ...EVENT, city: null } };
    await expect(airConnector(nowhere)).rejects.toThrow(/Konum yok/);
  });
});

describe("Brevo", () => {
  it("reads globalStats per campaign with the api-key header", async () => {
    const { f, calls } = fakeFetch((u) => ({ id: Number(u.pathname.split("/").pop()), name: "Davet", sentDate: "2026-10-01T09:00:00Z",
      statistics: { globalStats: { sent: 1000, delivered: 980, uniqueViews: 400, uniqueClicks: 90, hardBounces: 5, softBounces: 15 } } }));
    const r = await brevoConnector(ctx({ campaignIds: ["12"] }, f, { BREVO_API_KEY: "xkeysib-secret-123" }));
    expect(calls[0]!.url.href).toBe("https://api.brevo.com/v3/emailCampaigns/12?statistics=globalStats&excludeHtmlContent=true");
    expect((calls[0]!.init!.headers as Record<string, string>)["api-key"]).toBe("xkeysib-secret-123");
    expect(Object.fromEntries(r.observations.map((o) => [o.key, o.value]))).toEqual({
      "email.sent": 1000, "email.delivered": 980, "email.unique_opens": 400, "email.unique_clicks": 90, "email.hard_bounces": 5, "email.soft_bounces": 15,
    });
  });

  it("without a key: a clear error; provider errors never echo the key", async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ message: "Key not found" }), { status: 401 }));
    await expect(brevoConnector(ctx({ campaignIds: ["1"] }, f))).rejects.toThrow(/BREVO_API_KEY tanımlı değil/);
    const err = (await brevoConnector(ctx({ campaignIds: ["1"] }, f, { BREVO_API_KEY: "xkeysib-secret-123" })).catch((e: unknown) => e)) as ConnectorError;
    expect(err.message).toBe("HTTP 401: Key not found");
    expect(scrub("failed https://x/?key=abc&token=zzz with xkeysib-secret-123", ["xkeysib-secret-123"])).toBe("failed https://x/?key=***&token=*** with ***");
  });
});

describe("GA4", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: "svc@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });

  it("signs a JWT for analytics.readonly, then runs the period, baseline, landing and registration reports", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { f, calls } = fakeFetch((u, init) => {
      if (u.hostname === "oauth2.googleapis.com") return { access_token: "ya29.token" };
      const b = JSON.parse(String(init!.body)) as { dateRanges: { startDate: string }[]; dimensions?: { name: string }[] };
      bodies.push(b);
      if (!b.dimensions) return { rows: [{ metricValues: [{ value: b.dateRanges[0]!.startDate === "2026-09-20" ? "1500" : "1000" }] }] };
      if (b.dimensions.length === 1) return { rows: [{ dimensionValues: [{ value: "/kordon" }], metricValues: [{ value: "700" }] }, { dimensionValues: [{ value: "/kordon?a=1" }], metricValues: [{ value: "100" }] }], totals: [{ metricValues: [{ value: "750" }] }] };
      return { rows: [{ metricValues: [{ value: "60" }] }, { metricValues: [{ value: "15" }] }] };
    });
    const config = PROVIDER_CONFIG.GA4.parse({ propertyId: "345678901", landingPagePath: "/kordon", registrationEvent: "sign_up" });
    const r = await ga4Connector(ctx(config, f, { GA4_SERVICE_ACCOUNT_FILE: "/k.json" }, { "/k.json": sa }));
    // the token request: JWT bearer grant, RS256, verifiable with the account's public key
    const tokenBody = new URLSearchParams(String(calls[0]!.init!.body));
    expect(tokenBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, p, s] = tokenBody.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ iss: "svc@p.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/analytics.readonly",
      aud: "https://oauth2.googleapis.com/token" });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    expect(calls[1]!.url.href).toBe("https://analyticsdata.googleapis.com/v1beta/properties/345678901:runReport");
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer ya29.token");
    // period 2026-09-20 → 2026-10-21 (32 days), baseline the 32 days before
    expect(bodies[0]).toMatchObject({ dateRanges: [{ startDate: "2026-09-20", endDate: "2026-10-21" }] });
    expect(bodies[1]).toMatchObject({ dateRanges: [{ startDate: "2026-08-19", endDate: "2026-09-19" }] });
    expect(Object.fromEntries(r.observations.map((o) => [o.key, o.value]))).toEqual({
      "web.sessions_period": 1500, "web.sessions_baseline": 1000, "web.landing_users": 750, "web.landing_registrations": 75,
    });
  });

  it("explains a missing or broken key file", async () => {
    const { f } = fakeFetch(() => ({}));
    const config = PROVIDER_CONFIG.GA4.parse({ propertyId: "345678901", landingPagePath: "/k", registrationEvent: "sign_up" });
    await expect(ga4Connector(ctx(config, f))).rejects.toThrow(/GA4_SERVICE_ACCOUNT_FILE tanımlı değil/);
    await expect(ga4Connector(ctx(config, f, { GA4_SERVICE_ACCOUNT_FILE: "/none.json" }))).rejects.toThrow(/okunamadı/);
  });
});

describe("Meta", () => {
  it("Instagram posts in the period with reach and total_interactions; Facebook posts with the replacement reach metric; hashtag mentions", async () => {
    const { f, calls } = fakeFetch((u) => {
      const path = u.pathname;
      if (path.endsWith("/17841400/media")) return { data: [
        { id: "m1", timestamp: "2026-10-19T10:00:00+0000", permalink: "https://instagram.com/p/1" },
        { id: "m0", timestamp: "2026-08-01T10:00:00+0000" }, // before the period
      ] };
      if (path.endsWith("/m1/insights")) return { data: [{ name: "reach", period: "lifetime", values: [{ value: 5000 }] }, { name: "total_interactions", values: [{ value: 300 }] }] };
      if (path.endsWith("/ig_hashtag_search")) return { data: [{ id: "h1" }] };
      if (path.endsWith("/h1/recent_media")) return { data: [{ id: "t1", timestamp: "2026-10-20T08:00:00+0000" }, { id: "t2", timestamp: "2026-10-24T08:00:00+0000" }] };
      if (path.endsWith("/100000/posts")) return { data: [{ id: "100000_1", created_time: "2026-10-18T12:00:00+0000", shares: { count: 4 },
        reactions: { summary: { total_count: 50 } }, comments: { summary: { total_count: 6 } } }] };
      if (path.endsWith("/100000_1/insights")) return { data: [{ name: "post_total_media_view_unique", values: [{ value: 2000 }] }] };
      return new Response("{}", { status: 404 });
    });
    const config = PROVIDER_CONFIG.META.parse({ instagramUserId: "17841400", facebookPageId: "100000", hashtags: ["kordonfest"] });
    const r = await metaConnector(ctx(config, f, { META_ACCESS_TOKEN: "EAAG-secret-token" }));
    expect(calls[0]!.url.pathname).toBe("/v25.0/17841400/media");
    expect(calls.find((c) => c.url.pathname.endsWith("/m1/insights"))!.url.searchParams.get("metric")).toBe("reach,total_interactions");
    expect(calls.find((c) => c.url.pathname.endsWith("/100000_1/insights"))!.url.searchParams.get("metric")).toBe("post_total_media_view_unique");
    const by = (k: string) => Object.fromEntries(r.observations.filter((o) => o.key === k).map((o) => [o.dimension, o.value]));
    expect(by("social.reach")).toEqual({ "instagram:m1": 5000, "facebook:100000_1": 2000 });
    expect(by("social.interactions")).toEqual({ "instagram:m1": 300, "facebook:100000_1": 60 });
    // the promotion period ends 14 days after the event, but never after "today" (2026-10-25): both inside
    expect(by("social.mention")).toEqual({ "instagram:t1": 1, "instagram:t2": 1 });
  });
});

describe("YouTube", () => {
  it("adds the channel's videos in the period and reads statistics in batches", async () => {
    const { f, calls } = fakeFetch((u) => u.pathname.endsWith("/search")
      ? { items: [{ id: { videoId: "BBBBBBBBBBB" } }] }
      : { items: [
        { id: "AAAAAAAAAAA", snippet: { title: "Tanıtım", publishedAt: "2026-10-01T10:00:00Z" }, statistics: { viewCount: "1000", likeCount: "40", commentCount: "10" } },
        { id: "BBBBBBBBBBB", snippet: { title: "Gün 1" }, statistics: { viewCount: "500", commentCount: "5" } },
      ] });
    const config = PROVIDER_CONFIG.YOUTUBE.parse({ videoIds: ["AAAAAAAAAAA"], channelId: "UC" + "a".repeat(22) });
    const r = await youtubeConnector(ctx(config, f, { YOUTUBE_API_KEY: "AIza-secret" }));
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ channelId: "UC" + "a".repeat(22), type: "video", publishedAfter: "2026-09-20T00:00:00+03:00" });
    expect(calls[1]!.url.searchParams.get("id")).toBe("AAAAAAAAAAA,BBBBBBBBBBB");
    const by = (k: string) => Object.fromEntries(r.observations.filter((o) => o.key === k).map((o) => [o.dimension, o.value]));
    expect(by("youtube.views")).toEqual({ "video:AAAAAAAAAAA": 1000, "video:BBBBBBBBBBB": 500 });
    expect(by("youtube.likes")).toEqual({ "video:AAAAAAAAAAA": 40, "video:BBBBBBBBBBB": 0 }); // hidden likes → 0
  });
});

describe("press search", () => {
  const RSS = `<?xml version="1.0"?><rss><channel>
    <item><title>Kordon Gastronomi Festivali başladı - Yerel Haber</title><link>https://news.google.com/rss/articles/abc?oc=5</link>
      <pubDate>Tue, 20 Oct 2026 08:00:00 GMT</pubDate><source url="https://www.yerelhaber.com.tr">Yerel Haber</source></item>
    <item><title><![CDATA[Festivalde &amp; lezzet]]></title><link>https://news.google.com/rss/articles/def</link><pubDate>bad date</pubDate></item>
  </channel></rss>`;

  it("parses Google News RSS", () => {
    expect(parseNewsRss(RSS)).toEqual([
      { url: "https://news.google.com/rss/articles/abc?oc=5", title: "Kordon Gastronomi Festivali başladı - Yerel Haber", domain: "yerelhaber.com.tr",
        publishedAt: new Date("2026-10-20T08:00:00Z"), foundBy: "GOOGLE_NEWS" },
      { url: "https://news.google.com/rss/articles/def", title: "Festivalde & lezzet", domain: "news.google.com", publishedAt: null, foundBy: "GOOGLE_NEWS" },
    ]);
  });

  it("searches the exact title in GDELT and Google News; one failing source does not lose the other", async () => {
    const { f, calls } = fakeFetch((u) => u.hostname === "api.gdeltproject.org"
      ? new Response("Please limit requests to one every 5 seconds", { status: 429 })
      : RSS);
    const r = await newsConnector(ctx(PROVIDER_CONFIG.NEWS.parse({}), f));
    expect(calls[0]!.url.searchParams.get("query")).toBe('"Kordon Gastronomi Festivali"');
    expect(calls[0]!.url.searchParams.get("startdatetime")).toBe("20260920000000");
    expect(calls[1]!.url.searchParams.get("q")).toBe('"Kordon Gastronomi Festivali" after:2026-09-19 before:2026-10-26');
    expect(r.mentions).toHaveLength(2);
    expect(r.summary).toMatch(/GDELT: HTTP 429/);
  });
});

describe("provider configuration", () => {
  it("validates identifiers and requires something to read", () => {
    expect(PROVIDER_CONFIG.BREVO.safeParse({ campaignIds: [] }).success).toBe(false);
    expect(PROVIDER_CONFIG.BREVO.safeParse({ campaignIds: ["12a"] }).success).toBe(false);
    expect(PROVIDER_CONFIG.META.safeParse({}).success).toBe(false);
    expect(PROVIDER_CONFIG.YOUTUBE.safeParse({ videoIds: ["short"] }).success).toBe(false);
    expect(PROVIDER_CONFIG.GA4.safeParse({ propertyId: "345678901", landingPagePath: "kordon", registrationEvent: "sign_up" }).success).toBe(false);
    expect(PROVIDER_CONFIG.OPEN_METEO_AIR.parse({})).toEqual({ city: null, latitude: null, longitude: null });
  });
});
