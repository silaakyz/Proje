import { describe, expect, it } from "vitest";
import { hourLevel, pollutantLevel } from "@/lib/connectors/air-quality";
import { parseLeadsCsv, parseSponsorsCsv } from "@/lib/connectors/csv";
import { computeExternalKpis, EMPTY_EXTERNAL, type ExternalData, type Observation } from "@/lib/kpi/external";

const o = (provider: Observation["provider"], key: string, dimension: string, value: number): Observation => ({ provider, key, dimension, value, observedAt: null });
const get = (vals: ReturnType<typeof computeExternalKpis>, id: string) => vals.find((v) => v.id === id)!;

describe("EEA air quality bands", () => {
  it("places hourly concentrations in the published bands (rounded to whole µg/m³)", () => {
    expect([5, 5.4, 5.6, 15, 16, 50, 90, 140, 141].map((x) => pollutantLevel("pm2_5", x))).toEqual([1, 1, 2, 2, 3, 3, 4, 5, 6]);
    expect(pollutantLevel("ozone", 100)).toBe(2);
    expect(pollutantLevel("nitrogen_dioxide", 151)).toBe(6);
    expect(hourLevel({ pm2_5: 4, ozone: 110, pm10: null })).toBe(3); // the worst pollutant
    expect(hourLevel({})).toBeNull();
  });
});

describe("external KPIs", () => {
  const ex: ExternalData = {
    ...EMPTY_EXTERNAL,
    sources: [{ provider: "BREVO", lastSyncAt: "2026-10-22T10:00:00Z", lastStatus: "OK" }, { provider: "META", lastSyncAt: "2026-10-22T10:00:00Z", lastStatus: "OK" }],
    observations: [
      o("BREVO", "email.sent", "campaign:1", 1000), o("BREVO", "email.delivered", "campaign:1", 950), o("BREVO", "email.unique_opens", "campaign:1", 380),
      o("BREVO", "email.unique_clicks", "campaign:1", 95), o("BREVO", "email.hard_bounces", "campaign:1", 30), o("BREVO", "email.soft_bounces", "campaign:1", 20),
      o("GA4", "web.sessions_period", "", 1500), o("GA4", "web.sessions_baseline", "", 1000), o("GA4", "web.landing_users", "", 800), o("GA4", "web.landing_registrations", "", 40),
      o("META", "social.reach", "instagram:1", 4000), o("META", "social.reach", "facebook:2", 1000),
      o("META", "social.interactions", "instagram:1", 200), o("META", "social.interactions", "facebook:2", 50),
      o("META", "social.mention", "instagram:9", 1), o("META", "social.mention", "instagram:8", 1),
      o("YOUTUBE", "youtube.views", "video:a", 900), o("YOUTUBE", "youtube.likes", "video:a", 60), o("YOUTUBE", "youtube.comments", "video:a", 30),
      o("OPEN_METEO_AIR", "air.pm2_5", "h1", 4), o("OPEN_METEO_AIR", "air.ozone", "h1", 50),
      o("OPEN_METEO_AIR", "air.pm2_5", "h2", 12), o("OPEN_METEO_AIR", "air.pm2_5", "h3", 30), o("OPEN_METEO_AIR", "air.pm2_5", "h4", 2),
    ],
    mentions: { verified: 3, candidates: 5 },
  };

  it("follows the formulas", () => {
    const v = computeExternalKpis(ex, true);
    expect(get(v, "email_delivery_rate").value).toBe(95);
    expect(get(v, "email_bounce_rate").value).toBe(5);
    expect(get(v, "email_open_rate").value).toBe(40);
    expect(get(v, "email_click_rate").value).toBe(10);
    expect(get(v, "click_to_open_rate").value).toBe(25);
    expect(get(v, "landing_page_conversion_rate").value).toBe(5);
    expect(get(v, "website_traffic_uplift").value).toBe(50);
    expect(get(v, "social_reach").value).toBe(5000);
    expect(get(v, "social_engagement_rate").value).toBe(5);
    expect(get(v, "social_mentions_count").value).toBe(2);
    expect(get(v, "youtube_views").value).toBe(900);
    expect(get(v, "youtube_engagement_rate").value).toBe(10);
    expect(get(v, "media_coverage_count")).toMatchObject({ value: 3, note: expect.stringMatching(/aday: 5/) });
    // hours: h1 good, h2 fair, h3 moderate, h4 good → 75 % good/fair, worst level 3
    expect(get(v, "air_quality_good_fair_share").value).toBe(75);
    expect(get(v, "air_quality_worst_level").value).toBe(3);
    expect(get(v, "pm25_event_mean").value).toBe(12);
  });

  it("no source: empty with a pointer to the data-sources tab, never 0", () => {
    const v = computeExternalKpis(EMPTY_EXTERNAL, true);
    for (const id of ["email_open_rate", "social_reach", "air_quality_worst_level", "media_coverage_count", "leads_count", "sponsor_roi"]) {
      expect(get(v, id).value, id).toBeNull();
    }
    expect(get(v, "email_open_rate").note).toMatch(/bağlı değil/);
  });

  it("sponsors and leads from the uploads; money only with finance access", () => {
    const sponsors = parseSponsorsCsv("sponsor;bu_edisyon;onceki_edisyon;maliyet_tl;atfedilen_deger_tl;gosterim\r\nA;evet;evet;100.000,00;150000;1000000\r\nB;evet;hayır;50000;50000;\r\nC;hayır;evet;;;\r\n");
    expect(sponsors.issues).toEqual([]);
    const leads = parseLeadsCsv("lead_id;stant;izin;nitelikli;firsat;firsat_degeri_tl;kazanilan_gelir_tl;stant_suresi_dk\n" +
      "L1;X;evet;evet;evet;10000;4000;10\nL2;X;evet;evet;hayır;;;20\nL3;Y;hayır;evet;hayır;;;\nL4;Y;evet;hayır;hayır;;;30\n");
    expect(leads.issues).toEqual([]);
    const data = { ...EMPTY_EXTERNAL, sponsors: sponsors.rows, leads: leads.rows, leadProgramCostKurus: 200_000 };
    const v = computeExternalKpis(data, true);
    expect(get(v, "sponsor_renewal_rate").value).toBe(50); // A renewed, C did not
    expect(get(v, "sponsor_roi").value).toBe(((200_000 - 150_000) / 150_000) * 100);
    expect(get(v, "sponsor_cpm").value).toBe(100); // 100,000 TL / 1,000,000 × 1000
    expect(get(v, "leads_count").value).toBe(2); // consented and qualified
    expect(get(v, "avg_leads_per_exhibitor").value).toBe(1);
    expect(get(v, "lead_qualification_rate").value).toBe(75);
    expect(get(v, "avg_booth_dwell_minutes").value).toBe(20);
    expect(get(v, "lead_to_opportunity_rate").value).toBe(50);
    expect(get(v, "pipeline_influenced").value).toBe(10_000);
    expect(get(v, "attributed_closed_won_revenue").value).toBe(4_000);
    expect(get(v, "attributed_revenue_roi").value).toBe(((4_000 - 2_000) / 2_000) * 100);
    expect(get(v, "cost_per_lead").value).toBe(1_000);
    expect(get(v, "cost_per_opportunity").value).toBe(2_000);
    const staff = computeExternalKpis(data, false);
    expect(get(staff, "sponsor_roi")).toMatchObject({ value: null, note: expect.stringMatching(/yalnızca kurum sahibi/) });
    expect(get(staff, "leads_count").value).toBe(2);
  });
});

describe("CSV uploads", () => {
  it("drops personal columns, reports unknown ones, refuses the whole file on any bad row", () => {
    const ok = parseLeadsCsv("﻿Lead ID;Ad Soyad;E-posta;İzin;Nitelikli;Fırsat;Not\nL1;Ayşe;a@b.com;Evet;Evet;Hayır;x\n");
    expect(ok.issues).toEqual([]);
    expect(ok.droppedColumns).toEqual(["ad_soyad", "e_posta"]);
    expect(ok.unknownColumns).toEqual(["not"]);
    expect(ok.rows[0]).toMatchObject({ externalId: "L1", consent: true, qualified: true, opportunity: false });
    expect(JSON.stringify(ok.rows)).not.toMatch(/Ayşe|a@b\.com/);
    const bad = parseLeadsCsv("lead_id,izin,nitelikli,firsat,firsat_degeri_tl\nL1,evet,evet,hayır,500\nali@x.com,evet,evet,evet,\nL3,belki,evet,evet,\nL1,evet,evet,evet,\n");
    expect(bad.rows).toEqual([]);
    expect(bad.issues.map((i) => i.line)).toEqual([2, 3, 4, 5]);
    expect(parseSponsorsCsv("sponsor;bu_edisyon\nA;evet\n").issues).toEqual([{ line: 1, message: '"onceki_edisyon" sütunu yok' }]);
    expect(parseSponsorsCsv('sponsor,bu_edisyon,onceki_edisyon,maliyet_tl\n"Kitap, Yayın A.Ş.",evet,hayır,"1.250,50"\n').rows[0])
      .toMatchObject({ name: "Kitap, Yayın A.Ş.", costKurus: 125_050 });
  });
});
