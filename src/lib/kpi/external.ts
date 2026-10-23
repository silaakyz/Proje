/**
 * Metrics computed from external data (src/lib/connectors): observations pulled from outside services, verified
 * press mentions, and sponsor / lead lists uploaded as CSV. Pure; called by computeKpis (src/lib/kpi/engine.ts).
 *
 * Formulas are the KPI reference's (catalog), plus the platform-added air-quality and YouTube metrics whose
 * definitions are stated in the catalog. Choices made here (stated in each value's note):
 *   - e-mail: sums over the configured campaigns (Brevo globalStats); open rate counts unique opens, which privacy
 *     proxies (Apple MPP) inflate — the document says to treat clicks as primary.
 *   - social reach: provider-reported reach summed over platforms and posts; not unique people (document).
 *     Facebook "reach" is Meta's replacement metric post_total_media_view_unique (post_impressions_unique was
 *     removed in 2025). Engagement = interactions / reach × 100; interactions = Instagram total_interactions,
 *     Facebook reactions + comments + shares.
 *   - leads: "lead" = consented and qualified (document: izinli nitelikli lead); program cost = actual budget lines
 *     of category LEAD_PROGRAM.
 */
import type { Provider } from "@/lib/connectors/providers";
import { AIR_LEVEL_LABEL, AIR_POLLUTANTS, hourLevel, type AirPollutant } from "@/lib/connectors/air-quality";

export interface Observation {
  provider: Provider;
  key: string;
  dimension: string;
  value: number;
  observedAt: string | null;
}

export interface SponsorRow {
  currentEdition: boolean;
  previousEdition: boolean;
  costKurus: number | null;
  attributedValueKurus: number | null;
  impressions: number | null;
}

export interface LeadRow {
  exhibitor: string | null;
  consent: boolean;
  qualified: boolean;
  opportunity: boolean;
  opportunityValueKurus: number | null;
  wonRevenueKurus: number | null;
  boothMinutes: number | null;
}

export interface ExternalData {
  observations: readonly Observation[];
  /** Configured sources and their last pull (for notes and empty-state reasons). */
  sources: readonly { provider: Provider; lastSyncAt: string | null; lastStatus: string | null }[];
  mentions: { verified: number; candidates: number };
  sponsors: readonly SponsorRow[];
  leads: readonly LeadRow[];
  /** Actual LEAD_PROGRAM budget cost in kuruş; null when there is none or finance is hidden. */
  leadProgramCostKurus: number | null;
}

export const EMPTY_EXTERNAL: ExternalData = {
  observations: [], sources: [], mentions: { verified: 0, candidates: 0 }, sponsors: [], leads: [], leadProgramCostKurus: null,
};

type Val = { id: string; value: number | null; reason?: "no_data" | "zero_denominator"; n?: number; note?: string };

const ratio = (num: number, den: number, scale = 100) => (den > 0 ? (num / den) * scale : null);
const val = (id: string, value: number | null, extra: Omit<Val, "id" | "value"> = {}): Val =>
  value === null || !Number.isFinite(value)
    ? { id, value: null, reason: extra.reason ?? ((extra.n ?? 0) === 0 ? "no_data" : "zero_denominator"), ...extra }
    : { id, value, ...extra };

/** Ids this module produces (catalog `computable`); finance-gated ones are listed separately. */
export const EXTERNAL_KPI_IDS = [
  "email_delivery_rate", "email_bounce_rate", "email_open_rate", "email_click_rate", "click_to_open_rate",
  "landing_page_conversion_rate", "website_traffic_uplift",
  "social_reach", "social_engagement_rate", "social_mentions_count", "youtube_views", "youtube_engagement_rate",
  "media_coverage_count",
  "air_quality_good_fair_share", "air_quality_worst_level", "pm25_event_mean",
  "sponsor_renewal_rate",
  "leads_count", "avg_leads_per_exhibitor", "lead_qualification_rate", "avg_booth_dwell_minutes", "lead_to_opportunity_rate",
] as const;
export const EXTERNAL_FINANCE_KPI_IDS = [
  "sponsor_roi", "sponsor_cpm", "pipeline_influenced", "attributed_closed_won_revenue", "attributed_revenue_roi",
  "cost_per_lead", "cost_per_opportunity",
] as const;

export function computeExternalKpis(ex: ExternalData, finance: boolean): Val[] {
  const out: Val[] = [];
  const put = (x: Val) => out.push(x);
  const source = (p: Provider) => ex.sources.find((s) => s.provider === p);
  const noSource = (p: Provider, label: string) => (source(p) ? `${label}: henüz veri çekilmedi veya veri yok.` : `${label} veri kaynağı bağlı değil (Veri Kaynakları sekmesi).`);
  const obs = (key: string) => ex.observations.filter((o) => o.key === key);
  const sum = (key: string) => obs(key).reduce((s, o) => s + o.value, 0);
  const has = (key: string) => obs(key).length > 0;

  // --- e-mail (Brevo)
  const campaigns = new Set(obs("email.sent").map((o) => o.dimension)).size;
  const sent = sum("email.sent"), delivered = sum("email.delivered"), opens = sum("email.unique_opens"), clicks = sum("email.unique_clicks");
  const bounces = sum("email.hard_bounces") + sum("email.soft_bounces");
  const emailNote = campaigns ? `Brevo, ${campaigns} kampanya.` : noSource("BREVO", "E-posta");
  put(val("email_delivery_rate", campaigns ? ratio(delivered, sent) : null, { n: campaigns ? sent : 0, note: emailNote }));
  put(val("email_bounce_rate", campaigns ? ratio(bounces, sent) : null, { n: campaigns ? sent : 0, note: emailNote }));
  put(val("email_open_rate", campaigns ? ratio(opens, delivered) : null, {
    n: campaigns ? delivered : 0, note: campaigns ? `${emailNote} Tekil açılma; gizlilik proxy'leri (Apple MPP) şişirir, tıklamayı birincil alın.` : emailNote,
  }));
  put(val("email_click_rate", campaigns ? ratio(clicks, delivered) : null, { n: campaigns ? delivered : 0, note: emailNote }));
  put(val("click_to_open_rate", campaigns ? ratio(clicks, opens) : null, { n: campaigns ? opens : 0, note: emailNote }));

  // --- web (GA4)
  const users = sum("web.landing_users"), regs = sum("web.landing_registrations");
  put(val("landing_page_conversion_rate", has("web.landing_users") ? ratio(regs, users) : null, {
    n: has("web.landing_users") ? users : 0, note: has("web.landing_users") ? "GA4: açılış sayfasına inen tekil kullanıcılar ve oradan gelen kayıt olayları." : noSource("GA4", "Web sitesi"),
  }));
  const sp = sum("web.sessions_period"), sb = sum("web.sessions_baseline");
  put(val("website_traffic_uplift", has("web.sessions_baseline") ? ratio(sp - sb, sb) : null, {
    n: has("web.sessions_baseline") ? sb : 0, note: has("web.sessions_baseline") ? "GA4 oturumları: etkinlik dönemi ile eşit uzunluktaki önceki dönem (baz)." : noSource("GA4", "Web sitesi"),
  }));

  // --- social (Meta)
  const reachObs = obs("social.reach");
  const reachBy = (platform: string) => reachObs.filter((o) => o.dimension.startsWith(`${platform}:`)).reduce((s, o) => s + o.value, 0);
  const reach = sum("social.reach"), interactions = sum("social.interactions");
  const posts = reachObs.length;
  const reachNote = posts
    ? `Instagram ${Math.round(reachBy("instagram")).toLocaleString("tr-TR")} + Facebook ${Math.round(reachBy("facebook")).toLocaleString("tr-TR")}, ${posts} gönderi. Platformlar arası toplam tekil kişi değildir.`
    : noSource("META", "Sosyal medya");
  put(val("social_reach", posts ? reach : null, { n: posts, note: reachNote }));
  put(val("social_engagement_rate", posts ? ratio(interactions, reach) : null, {
    n: posts, note: posts ? "Etkileşim / erişim × 100. Instagram: total_interactions; Facebook: tepki + yorum + paylaşım." : reachNote,
  }));
  const mentions = new Set(obs("social.mention").map((o) => o.dimension)).size;
  const metaSrc = source("META");
  put(val("social_mentions_count", metaSrc && has("social.mention") ? mentions : metaSrc?.lastSyncAt ? 0 : null, {
    n: mentions, note: metaSrc ? "Instagram hashtag gönderileri (dönem içinde, tekil). Hashtag araması son 24 saati döndürür; sayım düzenli çekimlerle birikir." : noSource("META", "Sosyal medya"),
  }));

  // --- YouTube
  const videos = new Set(obs("youtube.views").map((o) => o.dimension)).size;
  const views = sum("youtube.views");
  const ytNote = videos ? `${videos} video; YouTube'un bildirdiği izlenme.` : noSource("YOUTUBE", "YouTube");
  put(val("youtube_views", videos ? views : null, { n: videos, note: ytNote }));
  put(val("youtube_engagement_rate", videos ? ratio(sum("youtube.likes") + sum("youtube.comments"), views) : null, {
    n: videos, note: videos ? "(beğeni + yorum) / izlenme × 100. Beğeni sayısı gizlenen videolarda 0 sayılır." : ytNote,
  }));

  // --- press
  const news = source("NEWS");
  const anyMention = ex.mentions.verified + ex.mentions.candidates > 0;
  put(val("media_coverage_count", anyMention || news?.lastSyncAt ? ex.mentions.verified : null, {
    n: ex.mentions.verified,
    note: anyMention || news ? `Doğrulanmış basın kupürü. Onay bekleyen aday: ${ex.mentions.candidates}.` : noSource("NEWS", "Basın taraması"),
  }));

  // --- air quality (Open-Meteo, EEA bands)
  const hours = new Map<string, Partial<Record<AirPollutant, number>>>();
  for (const o of ex.observations) {
    if (!o.key.startsWith("air.")) continue;
    const p = o.key.slice(4) as AirPollutant;
    if (!(AIR_POLLUTANTS as readonly string[]).includes(p)) continue;
    (hours.get(o.dimension) ?? hours.set(o.dimension, {}).get(o.dimension)!)[p] = o.value;
  }
  const levels = [...hours.values()].map(hourLevel).filter((l): l is number => l !== null);
  const pm = [...hours.values()].map((h) => h.pm2_5).filter((x): x is number => x !== undefined && Number.isFinite(x));
  const airNote = levels.length ? `Open-Meteo (Copernicus CAMS modeli), ${levels.length} etkinlik saati; AB Hava Kalitesi İndeksi bantları (EEA).` : noSource("OPEN_METEO_AIR", "Hava kalitesi");
  put(val("air_quality_good_fair_share", levels.length ? ratio(levels.filter((l) => l <= 2).length, levels.length) : null, { n: levels.length, note: airNote }));
  const worst = levels.length ? Math.max(...levels) : null;
  put(val("air_quality_worst_level", worst, { n: levels.length, note: worst ? `${airNote} En kötü saat: ${AIR_LEVEL_LABEL[worst - 1]} (1 = iyi, 6 = aşırı kötü).` : airNote }));
  put(val("pm25_event_mean", pm.length ? pm.reduce((s, x) => s + x, 0) / pm.length : null, { n: pm.length, note: pm.length ? `${airNote} µg/m³.` : airNote }));

  // --- sponsors (CSV)
  const csvNote = "CSV yüklemesi.";
  const prev = ex.sponsors.filter((s) => s.previousEdition);
  put(val("sponsor_renewal_rate", prev.length ? ratio(prev.filter((s) => s.currentEdition).length, prev.length) : null, {
    n: prev.length, note: prev.length ? `${csvNote} Önceki edisyonun sponsorlarından bu edisyonda da sponsor olanlar.` : "Önceki edisyon sponsoru işaretli satır yok.",
  }));
  const current = ex.sponsors.filter((s) => s.currentEdition);
  const hidden = "Tutar içerdiği için yalnızca kurum sahibi ve yöneticiye açık.";
  if (finance) {
    const roiRows = current.filter((s) => s.costKurus !== null && s.attributedValueKurus !== null);
    const cost = roiRows.reduce((s, r) => s + r.costKurus!, 0);
    const attributed = roiRows.reduce((s, r) => s + r.attributedValueKurus!, 0);
    put(val("sponsor_roi", roiRows.length ? ratio(attributed - cost, cost) : null, {
      n: roiRows.length, note: `${csvNote} Atfedilen değer sponsorla önceden anlaşılan değerdir; maliyet ve değeri olan sponsorlar.`,
    }));
    const cpmRows = current.filter((s) => s.costKurus !== null && s.impressions !== null);
    put(val("sponsor_cpm", cpmRows.length ? ratio(cpmRows.reduce((s, r) => s + r.costKurus!, 0) / 100, cpmRows.reduce((s, r) => s + r.impressions!, 0), 1000) : null, {
      n: cpmRows.length, note: `${csvNote} Sponsorluk maliyeti / gösterim × 1000.`,
    }));
  } else {
    for (const id of ["sponsor_roi", "sponsor_cpm"]) put(val(id, null, { reason: "no_data", note: hidden }));
  }

  // --- leads (CSV)
  const L = ex.leads;
  const leads = L.filter((l) => l.consent && l.qualified);
  const opps = leads.filter((l) => l.opportunity);
  const exhibitors = new Set(L.map((l) => l.exhibitor?.trim()).filter(Boolean)).size;
  const leadNote = L.length ? `${csvNote} Lead = izinli ve nitelikli.` : "Lead listesi yüklenmedi.";
  put(val("leads_count", L.length ? leads.length : null, { n: L.length, note: leadNote }));
  put(val("avg_leads_per_exhibitor", L.length ? ratio(leads.length, exhibitors, 1) : null, { n: exhibitors, note: L.length ? `${leadNote} Stant sayısı = listedeki farklı stant.` : leadNote }));
  put(val("lead_qualification_rate", L.length ? ratio(L.filter((l) => l.qualified).length, L.length) : null, { n: L.length, note: L.length ? `${csvNote} Nitelikli / yakalanan.` : leadNote }));
  const dwell = L.filter((l) => l.boothMinutes !== null);
  put(val("avg_booth_dwell_minutes", dwell.length ? dwell.reduce((s, l) => s + l.boothMinutes!, 0) / dwell.length : null, { n: dwell.length, note: dwell.length ? csvNote : leadNote }));
  put(val("lead_to_opportunity_rate", L.length ? ratio(opps.length, leads.length) : null, { n: leads.length, note: leadNote }));
  if (finance) {
    const pipeline = opps.filter((l) => l.opportunityValueKurus !== null);
    put(val("pipeline_influenced", L.length ? pipeline.reduce((s, l) => s + l.opportunityValueKurus!, 0) / 100 : null, { n: pipeline.length, note: leadNote }));
    const won = L.filter((l) => l.wonRevenueKurus !== null);
    const wonTry = won.reduce((s, l) => s + l.wonRevenueKurus!, 0) / 100;
    put(val("attributed_closed_won_revenue", won.length ? wonTry : null, {
      n: won.length, note: won.length ? `${csvNote} Atıf penceresi ve çoklu temas kuralı kurumun; tutarlar CSV'de bu kurala göre girilir.` : "Kazanılan gelir sütunu dolu satır yok.",
    }));
    const program = ex.leadProgramCostKurus === null ? null : ex.leadProgramCostKurus / 100;
    const progNote = program === null ? "Bütçede 'Lead / iş geliştirme programı' gideri (gerçekleşen) yok." : "Program maliyeti = bütçedeki lead programı giderleri.";
    put(val("attributed_revenue_roi", program !== null && won.length ? ratio(wonTry - program, program) : null, { n: won.length, note: progNote }));
    put(val("cost_per_lead", program !== null && L.length ? ratio(program, leads.length, 1) : null, { n: leads.length, note: progNote }));
    put(val("cost_per_opportunity", program !== null && L.length ? ratio(program, opps.length, 1) : null, { n: opps.length, note: progNote }));
  } else {
    for (const id of ["pipeline_influenced", "attributed_closed_won_revenue", "attributed_revenue_roi", "cost_per_lead", "cost_per_opportunity"]) {
      put(val(id, null, { reason: "no_data", note: hidden }));
    }
  }
  return out;
}
