/**
 * What an uploaded table's columns can mean ("measures") and which catalog metrics they feed, with the catalog's
 * formulas (src/lib/kpi/catalog.ts). A column is mapped to one role:
 *   date      the row's date (time series)
 *   group     a label to break values down by (session, stand, day, area …)
 *   measure   one of MEASURES below → feeds catalog metrics
 *   value     another number: summarised and charted, feeds no metric
 *   ignore    not used
 * Mapping is proposed (header keywords; optionally a model reading column statistics) and confirmed by a person.
 */
import type { Column } from "@/lib/datasets/table";
import { fold } from "@/lib/datasets/table";

export type Aggregation = "sum" | "mean" | "max" | "share_true" | "values";

export interface Measure {
  key: string;
  label: string;
  /** For people and for the model that proposes a mapping. */
  description: string;
  type: "number" | "boolean";
  agg: Aggregation;
  unit: string;
  /** Folded header fragments that suggest this measure (more specific measures are listed first). */
  keywords: string[];
  feeds: string[];
}

export const MEASURES: readonly Measure[] = [
  { key: "recycled_kg", label: "Geri dönüşüme giden atık (kg)", description: "Geri dönüşüme / geri kazanıma giden atık miktarı, kilogram", type: "number", agg: "sum", unit: "kg",
    keywords: ["geri_donus", "geri_kazanim", "recycl"], feeds: ["recycling_rate"] },
  { key: "waste_kg", label: "Toplam atık (kg)", description: "Toplanan toplam atık, kilogram (geri dönüşüm dahil)", type: "number", agg: "sum", unit: "kg",
    keywords: ["atik", "waste", "cop"], feeds: ["waste_per_attendee_kg", "recycling_rate"] },
  { key: "emission_factor", label: "Emisyon faktörü (kg CO₂e / birim)", description: "Faaliyet birimi başına emisyon faktörü; faaliyet miktarıyla satır satır çarpılır", type: "number", agg: "values", unit: "kgCO2e/birim",
    keywords: ["emisyon_faktor", "emission_factor", "faktor"], feeds: ["carbon_footprint_kgco2e", "carbon_per_attendee_kgco2e"] },
  { key: "emission_activity", label: "Faaliyet miktarı (emisyon için)", description: "Emisyon hesabındaki faaliyet miktarı (kWh, litre, km …); aynı satırdaki faktörle çarpılır", type: "number", agg: "values", unit: "birim",
    keywords: ["faaliyet_miktar", "activity_amount", "tuketim"], feeds: ["carbon_footprint_kgco2e", "carbon_per_attendee_kgco2e"] },
  { key: "co2e_kg", label: "Hesaplanmış emisyon (kg CO₂e)", description: "Zaten hesaplanmış sera gazı emisyonu, kg CO₂e", type: "number", agg: "sum", unit: "kgCO2e",
    keywords: ["co2", "karbon", "sera_gaz", "emisyon"], feeds: ["carbon_footprint_kgco2e", "carbon_per_attendee_kgco2e"] },
  { key: "incidents", label: "Olay sayısı", description: "Güvenlik / sağlık / operasyon olayı sayısı", type: "number", agg: "sum", unit: "adet",
    keywords: ["olay", "incident", "vaka", "kaza", "mudahale"], feeds: ["incident_rate_per_1000"] },
  { key: "complaints", label: "Şikâyet sayısı", description: "Alınan şikâyet sayısı", type: "number", agg: "sum", unit: "adet",
    keywords: ["sikayet", "complaint"], feeds: ["complaint_rate_per_1000"] },
  { key: "issue_resolution_minutes", label: "Sorun çözüm süresi (dk)", description: "Bir sorunun bildirilmesinden çözülmesine kadar geçen süre, dakika (satır başına bir sorun)", type: "number", agg: "values", unit: "dk",
    keywords: ["cozum_sure", "resolution"], feeds: ["issue_resolution_avg_minutes"] },
  { key: "checkin_wait_minutes", label: "Girişte bekleme süresi (dk)", description: "Kuyrukta bekleme / check-in süresi, dakika (satır başına bir ölçüm)", type: "number", agg: "values", unit: "dk",
    keywords: ["bekleme", "kuyruk", "wait"], feeds: ["checkin_avg_minutes", "checkin_p90_minutes"] },
  { key: "additional_staff", label: "Etkinlik nedeniyle ek personel", description: "Yerel işletmelerin etkinlik için işe aldığı ek personel", type: "number", agg: "sum", unit: "kişi",
    keywords: ["ek_personel", "additional_staff", "ilave_personel"], feeds: ["additional_staff"] },
  { key: "staff", label: "Görevli personel sayısı", description: "Etkinlikte görev yapan personel / gönüllü sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["personel", "gorevli", "gonullu", "staff"], feeds: ["attendees_per_staff"] },
  { key: "badge_reprints", label: "Yeniden basılan yaka kartı", description: "Yeniden basılan yaka kartı / rozet sayısı", type: "number", agg: "sum", unit: "adet",
    keywords: ["yeniden_basim", "reprint"], feeds: ["badge_reprint_rate"] },
  { key: "badges_printed", label: "Basılan yaka kartı", description: "Basılan toplam yaka kartı / rozet sayısı", type: "number", agg: "sum", unit: "adet",
    keywords: ["yaka_kart", "rozet", "badge"], feeds: ["badge_reprint_rate"] },
  { key: "vendor_on_time", label: "Tedarik zamanında teslim edildi", description: "Bir tedarik / teslimatın zamanında yapılıp yapılmadığı (evet/hayır, satır başına bir teslimat)", type: "boolean", agg: "share_true", unit: "",
    keywords: ["zamaninda_teslim", "on_time_deliver", "teslimat"], feeds: ["vendor_on_time_rate"] },
  { key: "session_on_time", label: "Oturum zamanında başladı", description: "Oturumun zamanında başlayıp başlamadığı (evet/hayır, satır başına bir oturum)", type: "boolean", agg: "share_true", unit: "",
    keywords: ["zamaninda_basla", "on_time_start", "zamaninda"], feeds: ["schedule_adherence_rate"] },
  { key: "session_capacity", label: "Oturum kapasitesi", description: "Oturum / salon kapasitesi (satır başına bir oturum)", type: "number", agg: "sum", unit: "kişi",
    keywords: ["kapasite", "capacity"], feeds: ["session_fill_rate"] },
  { key: "session_registered", label: "Oturum kaydı", description: "Oturuma kayıtlı kişi sayısı (satır başına bir oturum)", type: "number", agg: "sum", unit: "kişi",
    keywords: ["oturum_kayit", "session_registr"], feeds: ["session_attendance_rate"] },
  { key: "session_checkins", label: "Oturum katılımı", description: "Oturuma gerçekten katılan / giriş yapan kişi sayısı (satır başına bir oturum)", type: "number", agg: "sum", unit: "kişi",
    keywords: ["oturum_katilim", "oturum_giris", "salon_giris", "session_attend", "session_check"], feeds: ["session_attendance_rate", "session_fill_rate", "avg_sessions_per_attendee"] },
  { key: "session_rating", label: "Oturum puanı (1–5)", description: "Oturum değerlendirme puanı, 1–5 ölçeği", type: "number", agg: "mean", unit: "/5",
    keywords: ["oturum_puan", "session_rating", "puan", "rating", "degerlendirme"], feeds: ["session_satisfaction"] },
  { key: "meetings_planned", label: "Planlanan toplantı", description: "Planlanan B2B / ikili görüşme sayısı", type: "number", agg: "sum", unit: "adet",
    keywords: ["planlanan_toplanti", "planlanan_gorusme", "planned_meeting"], feeds: ["meeting_completion_rate"] },
  { key: "meetings_held", label: "Gerçekleşen toplantı", description: "Gerçekleşen B2B / ikili görüşme sayısı", type: "number", agg: "sum", unit: "adet",
    keywords: ["gerceklesen_toplanti", "gerceklesen_gorusme", "toplanti", "gorusme", "meeting"], feeds: ["meeting_completion_rate", "meetings_per_attendee"] },
  { key: "qa_participants", label: "Soru-cevaba katılan", description: "Soru-cevaba katılan kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["soru_cevap", "q_a", "qa"], feeds: ["qa_participation_rate"] },
  { key: "poll_respondents", label: "Anlık anket yanıtlayan", description: "Etkinlik sırasındaki anlık ankete yanıt veren kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["anlik_anket", "poll"], feeds: ["poll_response_rate"] },
  { key: "active_engaged", label: "Etkileşim yapan katılımcı", description: "En az bir etkileşim (soru, oylama, paylaşım …) yapan tekil katılımcı sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["etkilesim_yapan", "aktif_katilimci", "engaged"], feeds: ["active_engagement_rate"] },
  { key: "virtual_registered", label: "Sanal kayıt", description: "Çevrim içi / sanal katılım için kayıtlı kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["sanal_kayit", "online_kayit", "virtual_regist"], feeds: ["virtual_attendance_rate"] },
  { key: "live_viewers", label: "Canlı izleyen", description: "Canlı yayını izleyen tekil kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["canli_izley", "live_view", "izleyici"], feeds: ["virtual_attendance_rate"] },
  { key: "concurrent_viewers", label: "Eşzamanlı izleyici", description: "Bir andaki eşzamanlı izleyici sayısı (zaman serisi)", type: "number", agg: "max", unit: "kişi",
    keywords: ["eszamanli", "concurrent"], feeds: ["peak_concurrent_viewers"] },
  { key: "watch_minutes", label: "İzleme süresi (dk)", description: "İzleyici başına izleme süresi, dakika (satır başına bir izleyici)", type: "number", agg: "values", unit: "dk",
    keywords: ["izleme_sure", "watch_time", "watch_min"], feeds: ["avg_watch_minutes"] },
  { key: "vendor_sales_event", label: "Etkinlik dönemi satış", description: "Yerel işletmenin etkinlik dönemindeki satış / cirosu, TL", type: "number", agg: "sum", unit: "TL",
    keywords: ["etkinlik_donemi_satis", "etkinlik_satis", "etkinlik_ciro", "event_sales"], feeds: ["vendor_revenue_change"] },
  { key: "vendor_sales_baseline", label: "Karşılaştırılabilir baz satış", description: "Aynı işletmenin karşılaştırılabilir normal dönemdeki satış / cirosu, TL", type: "number", agg: "sum", unit: "TL",
    keywords: ["baz_satis", "normal_gun", "baseline_sales", "onceki_satis", "baz_ciro"], feeds: ["vendor_revenue_change"] },
  { key: "registrations_started", label: "Başlatılan kayıt", description: "Kayıt formunu açıp başlayan kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["baslatilan_kayit", "started_regist"], feeds: ["registration_completion_rate"] },
  { key: "registrations_completed", label: "Tamamlanan kayıt", description: "Kayıt formunu tamamlayan kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["tamamlanan_kayit", "completed_regist"], feeds: ["registration_completion_rate"] },
  { key: "waitlist_converted", label: "Bekleme listesinden dönen", description: "Bekleme listesinden kesin kayda dönen kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["bekleme_listesinden", "waitlist_conv"], feeds: ["waitlist_conversion_rate"] },
  { key: "waitlist", label: "Bekleme listesi", description: "Bekleme listesine giren kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["bekleme_liste", "waitlist"], feeds: ["waitlist_conversion_rate"] },
  { key: "walk_ins", label: "Kapıdan kayıt (walk-in)", description: "Önceden kaydı olmadan kapıda kayıt olup gelen kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["kapidan", "walk_in", "walkin"], feeds: ["walk_in_share"] },
  { key: "early_bird", label: "Erken kayıt", description: "Erken kayıt döneminde kaydolan kişi sayısı", type: "number", agg: "sum", unit: "kişi",
    keywords: ["erken_kayit", "early_bird"], feeds: ["early_bird_share"] },
  { key: "visitors", label: "Ziyaretçi / giriş sayısı", description: "Sayılan ziyaretçi veya giriş sayısı (örn. günlük kapı sayımı)", type: "number", agg: "sum", unit: "kişi",
    keywords: ["ziyaretci", "katilimci", "gelen", "giris_sayi", "visitor", "attendance", "footfall"], feeds: [] },
];

export const MEASURE_BY_KEY: ReadonlyMap<string, Measure> = new Map(MEASURES.map((m) => [m.key, m]));

export type Role = "date" | "group" | "value" | "ignore" | `measure:${string}`;
export interface ColumnMapping { key: string; role: Role; source: "rule" | "ai" | "user"; note?: string }

/** Rule-based proposal from header keywords and column types. */
/** In a table about sessions (a column names them), plain "registered / attended" headers mean session figures. */
const SESSION_CONTEXT: Record<string, string[]> = {
  session_registered: ["kayitli", "kayit", "registered"],
  session_checkins: ["katilan", "katilim", "giris", "attended", "checkin"],
};

export function proposeMapping(columns: readonly Column[], rowCount: number): ColumnMapping[] {
  const used = new Set<string>();
  const sessions = columns.some((c) => /oturum|session|salon|konusma|panel|atolye/.test(fold(c.header)));
  const keywords = (m: Measure) => (sessions && SESSION_CONTEXT[m.key] ? [...m.keywords, ...SESSION_CONTEXT[m.key]!] : m.keywords);
  return columns.map((c) => {
    const h = fold(c.header);
    if (c.type === "date") return { key: c.key, role: "date", source: "rule" };
    if (c.type === "number" || c.type === "boolean") {
      const m = MEASURES.find((x) => x.type === c.type && !used.has(x.key) && keywords(x).some((k) => h.includes(k)));
      if (m) {
        used.add(m.key);
        return { key: c.key, role: `measure:${m.key}`, source: "rule" };
      }
      return { key: c.key, role: c.type === "number" ? "value" : "ignore", source: "rule" };
    }
    // text: a short label to group by (session, stand, area …); long free text is ignored
    const short = (c.stats.top ?? []).every((t) => t.value.length <= 60);
    const labelLike = c.distinct <= 200 && (rowCount <= 50 || c.distinct <= rowCount * 0.6) && short && c.stats.top !== undefined;
    return { key: c.key, role: labelLike ? "group" : "ignore", source: "rule" };
  });
}

/** Checks a mapping against the columns: measure exists, types match, each measure used once. */
export function validateMapping(columns: readonly Column[], mapping: readonly ColumnMapping[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const m of mapping) {
    const c = columns.find((x) => x.key === m.key);
    if (!c) { errors.push(`bilinmeyen sütun: ${m.key}`); continue; }
    if (m.role === "date" && c.type !== "date") errors.push(`${c.header}: tarih değil`);
    if (m.role === "value" && c.type !== "number") errors.push(`${c.header}: sayı değil`);
    if (m.role.startsWith("measure:")) {
      const ms = MEASURE_BY_KEY.get(m.role.slice(8));
      if (!ms) errors.push(`${c.header}: bilinmeyen ölçü`);
      else if (ms.type !== c.type) errors.push(`${c.header}: "${ms.label}" ${ms.type === "number" ? "sayı" : "evet/hayır"} ister`);
      else {
        if (seen.has(ms.key)) errors.push(`"${ms.label}" birden fazla sütuna atanmış`);
        seen.add(ms.key);
      }
    }
  }
  return errors;
}
