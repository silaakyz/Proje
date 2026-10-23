/**
 * External data sources an event can pull metric inputs from (client-safe: no secrets here). Each provider has a
 * per-event configuration (what to read: campaign ids, a GA4 property, page ids, search terms, a location) and,
 * where the service needs one, a server-wide credential in the environment (`envKeys`) — never in the database.
 *
 * What each provider feeds (KPI reference ids, src/lib/kpi/catalog.ts):
 *   OPEN_METEO_AIR  air_quality_good_fair_share, air_quality_worst_level, pm25_event_mean   (no key)
 *   BREVO           email_delivery_rate, email_bounce_rate, email_open_rate, email_click_rate, click_to_open_rate
 *   GA4             landing_page_conversion_rate, website_traffic_uplift
 *   META            social_reach, social_engagement_rate, social_mentions_count (Instagram hashtags)
 *   YOUTUBE         youtube_views, youtube_engagement_rate
 *   NEWS            media_coverage_count (candidates from GDELT and Google News; a person verifies each one)
 */
import { z } from "zod";

export const PROVIDERS = ["OPEN_METEO_AIR", "BREVO", "GA4", "META", "YOUTUBE", "NEWS"] as const;
export type Provider = (typeof PROVIDERS)[number];

const ids = (max: number, re: RegExp, what: string) =>
  z.array(z.string().trim().regex(re, `invalid ${what}`)).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** Per-event configuration. Dates default to the event's own dates where a provider needs a period. */
export const PROVIDER_CONFIG = {
  OPEN_METEO_AIR: z.object({
    /** City name for geocoding; defaults to the event profile's city. Coordinates win when given. */
    city: z.string().trim().min(2).max(100).nullable().default(null),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
  }),
  BREVO: z.object({
    campaignIds: ids(50, /^\d{1,12}$/, "Brevo campaign id").min(1),
  }),
  GA4: z.object({
    propertyId: z.string().trim().regex(/^\d{4,15}$/, "GA4 property id (digits)"),
    /** Landing page path of the event (begins-with match), e.g. "/kordon-festivali". */
    landingPagePath: z.string().trim().regex(/^\/[^\s]{0,300}$/, "path starting with /"),
    /** GA4 event name that marks a registration, e.g. "sign_up" or "generate_lead". */
    registrationEvent: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "GA4 event name"),
    /** Campaign period (defaults: 30 days before the event start → event end) and its baseline. */
    periodStart: isoDate.nullable().default(null),
    periodEnd: isoDate.nullable().default(null),
    baselineStart: isoDate.nullable().default(null),
    baselineEnd: isoDate.nullable().default(null),
  }),
  META: z.object({
    instagramUserId: z.string().trim().regex(/^\d{5,25}$/, "Instagram business account id").nullable().default(null),
    facebookPageId: z.string().trim().regex(/^\d{5,25}$/, "Facebook page id").nullable().default(null),
    /** Instagram hashtags (without #) whose posts count as mentions. */
    hashtags: ids(10, /^[\p{L}\p{N}_]{2,100}$/u, "hashtag").default([]),
    periodStart: isoDate.nullable().default(null),
    periodEnd: isoDate.nullable().default(null),
  }).refine((c) => c.instagramUserId || c.facebookPageId, { message: "an Instagram account or a Facebook page is required", path: ["instagramUserId"] }),
  YOUTUBE: z.object({
    videoIds: ids(50, /^[A-Za-z0-9_-]{11}$/, "YouTube video id").default([]),
    /** With a channel, its videos published in the period are added (search.list costs 100 quota units). */
    channelId: z.string().trim().regex(/^UC[A-Za-z0-9_-]{22}$/, "YouTube channel id").nullable().default(null),
    periodStart: isoDate.nullable().default(null),
    periodEnd: isoDate.nullable().default(null),
  }).refine((c) => c.videoIds.length > 0 || c.channelId, { message: "a video id or a channel id is required", path: ["videoIds"] }),
  NEWS: z.object({
    /** Exact phrases searched in news; defaults to the event title. */
    terms: z.array(z.string().trim().min(3).max(120)).max(5).default([]),
    periodStart: isoDate.nullable().default(null),
    periodEnd: isoDate.nullable().default(null),
  }),
} satisfies Record<Provider, z.ZodType>;

export type ProviderConfig<P extends Provider> = z.infer<(typeof PROVIDER_CONFIG)[P]>;

/**
 * Automatic pull frequency, chosen per source (minutes; 0 = automatic pulls off, "Şimdi Çek" still works).
 * Each provider has a default and limits that follow its data and its quota (PROVIDER_INFO.sync).
 */
export const SYNC_INTERVALS = [15, 30, 60, 180, 360, 720, 1440, 4320] as const;
export function syncIntervalLabel(minutes: number) {
  if (minutes === 0) return "Otomatik çekme kapalı";
  if (minutes < 60) return `${minutes} dakikada bir`;
  if (minutes < 1440) return minutes === 60 ? "Saatte bir" : `${minutes / 60} saatte bir`;
  return minutes === 1440 ? "Günde bir" : `${minutes / 1440} günde bir`;
}

export const PROVIDER_INFO: Record<Provider, {
  label: string;
  /** Server environment variables the connector needs (names only). */
  envKeys: readonly string[];
  feeds: readonly string[];
  terms: string;
  docs: string;
  /** Automatic pulls: default, fastest and slowest allowed interval (minutes), and why. */
  sync: { defaultMinutes: number; minMinutes: number; maxMinutes: number; note: string };
}> = {
  OPEN_METEO_AIR: {
    label: "Hava kalitesi (Open-Meteo)",
    envKeys: [],
    feeds: ["air_quality_good_fair_share", "air_quality_worst_level", "pm25_event_mean"],
    terms: "Anahtar gerekmez. Ücretsiz kullanım ticari olmayan amaçlar ve günde 10.000 istekle sınırlıdır; ticari kullanım abonelik ister. Veri: Copernicus CAMS modeli (ölçüm istasyonu değil).",
    docs: "https://open-meteo.com/en/docs/air-quality-api",
    sync: { defaultMinutes: 60, minMinutes: 15, maxMinutes: 4320, note: "Model verisi saatlik güncellenir; ücretsiz kullanım günde 10.000 istekle sınırlı." },
  },
  BREVO: {
    label: "E-posta (Brevo)",
    envKeys: ["BREVO_API_KEY"],
    feeds: ["email_delivery_rate", "email_bounce_rate", "email_open_rate", "email_click_rate", "click_to_open_rate"],
    terms: "Brevo hesabınızda SMTP & API → API Keys bölümünden bir anahtar oluşturun. Kampanya kimlikleri kampanya adresindeki sayıdır.",
    docs: "https://developers.brevo.com/reference/get-email-campaign",
    sync: { defaultMinutes: 360, minMinutes: 30, maxMinutes: 4320, note: "Kampanya istatistikleri gönderimden sonraki günlerde yavaşça değişir." },
  },
  GA4: {
    label: "Web sitesi (Google Analytics 4)",
    envKeys: ["GA4_SERVICE_ACCOUNT_FILE"],
    feeds: ["landing_page_conversion_rate", "website_traffic_uplift"],
    terms: "Google Cloud'da bir servis hesabı ve JSON anahtarı oluşturun, Analytics Data API'yi etkinleştirin ve servis hesabının e-postasını GA4 mülküne Görüntüleyici olarak ekleyin.",
    docs: "https://developers.google.com/analytics/devguides/reporting/data/v1",
    sync: { defaultMinutes: 720, minMinutes: 180, maxMinutes: 4320, note: "GA4 verisi 24–48 saatte kesinleşir; daha sık çekmek yeni bilgi getirmez." },
  },
  META: {
    label: "Instagram ve Facebook (Meta)",
    envKeys: ["META_ACCESS_TOKEN"],
    feeds: ["social_reach", "social_engagement_rate", "social_mentions_count"],
    terms: "Bir Meta uygulaması ve işletme hesabına bağlı Facebook sayfası gerekir. Erişim belirteci izinleri: instagram_basic, instagram_manage_insights, pages_read_engagement, read_insights. Hashtag araması son 24 saati döndürür; düzenli çekim bu yüzden önemlidir.",
    docs: "https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/",
    sync: { defaultMinutes: 360, minMinutes: 60, maxMinutes: 1440, note: "Hashtag araması yalnızca son 24 saati verir: günde birden seyrek çekilirse paylaşımlar kaçırılır. Meta saatlik istek sınırı uygular." },
  },
  YOUTUBE: {
    label: "YouTube",
    envKeys: ["YOUTUBE_API_KEY"],
    feeds: ["youtube_views", "youtube_engagement_rate"],
    terms: "Google Cloud'da YouTube Data API v3'ü etkinleştirip bir API anahtarı oluşturun. Günlük ücretsiz kota 10.000 birimdir.",
    docs: "https://developers.google.com/youtube/v3/docs/videos/list",
    sync: { defaultMinutes: 360, minMinutes: 60, maxMinutes: 4320, note: "Günlük 10.000 birimlik kota tüm etkinliklerle paylaşılır." },
  },
  NEWS: {
    label: "Basın taraması (GDELT, Google News)",
    envKeys: [],
    feeds: ["media_coverage_count"],
    terms: "Anahtar gerekmez. Bulunan haberler aday olarak listelenir; basın kupürü sayılması için bir kişinin onaylaması gerekir. GDELT son 3 ayı kapsar.",
    docs: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
    sync: { defaultMinutes: 180, minMinutes: 15, maxMinutes: 4320, note: "GDELT 15 dakikada bir güncellenir; haberler bulundukça aday olarak eklenir." },
  },
};

/** Days of an event window: pulls run from 60 days before the start until 30 days after the end. */
export const SYNC_WINDOW = { daysBefore: 60, daysAfter: 30 } as const;

export const MENTION_STATUSES = ["CANDIDATE", "VERIFIED", "REJECTED"] as const;
export type MentionStatus = (typeof MENTION_STATUSES)[number];

/** The interval a source uses: its own choice, or the provider default. */
export const effectiveSyncMinutes = (provider: Provider, chosen: number | null | undefined) => chosen ?? PROVIDER_INFO[provider].sync.defaultMinutes;

/** Choices offered for a provider: off, then the intervals inside its limits. */
export const syncChoices = (provider: Provider) => {
  const { minMinutes, maxMinutes } = PROVIDER_INFO[provider].sync;
  return [0, ...SYNC_INTERVALS.filter((m) => m >= minMinutes && m <= maxMinutes)];
};
