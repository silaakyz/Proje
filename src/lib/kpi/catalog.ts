/**
 * KPI catalog — transcribed from "Etkinlik Etki Analizi — KPI ve Formül Referansı (Kaynaklı)" (22 Oct 2026),
 * the organization's own reference document. Every formula below is the document's; nothing is added.
 *
 * Evidence codes (document §1):
 *   K — verified from a source in that study (refs = numbers in KPI_SOURCES)
 *   S — standard statistical / accounting definition (not individually sourced there)
 *   T — design / methodology decision: no universal formula; versioned here and stated in reports
 *
 * Additions not in the document are marked `origin: "platform"` and carry their own definition and sources (air
 * quality from the EEA index, YouTube counts as reported by the provider); reports must say they are additions.
 *
 * `computable` says whether the platform collects the inputs today (see src/lib/kpi/engine.ts); the rest are
 * catalogued with the data they need, so the gap is explicit instead of invented.
 */

import { DATASET_KPI_IDS } from "@/lib/kpi/datasets";

export const KPI_CATALOG_VERSION = "kpi-catalog/2026-10-22" as const;

export type Evidence = "K" | "S" | "T";

export const KPI_SOURCES: Record<number, { title: string; url: string; note?: string }> = {
  1: { title: "Momentus, Key Performance Indicators for Event Management", url: "https://gomomentus.com/blog/key-performance-indicators-for-event-management", note: "satıcı blogu" },
  2: { title: "Cvent, Event reporting", url: "https://www.cvent.com/uk/event-management-software/event-reporting", note: "yalnızca metrik aileleri" },
  3: { title: "Cvent, Essential Guide to Event ROI", url: "https://www.cvent.com/en/resource/essential-guide-to-event-roi", note: "form arkasında, okunamadı" },
  4: { title: "International Association of Event Hosts, Economic Impacts (eventIMPACTS)", url: "https://www.eventhosts.org/resources/event-impact-standards/economic-impacts-2/" },
  5: { title: "Frontline, eventIMPACTS tabanlı etki raporu örneği", url: "https://www.nottinghamshire.gov.uk/media/1532200/stage-7-west-bridgford-to-mansfield-economic-report.pdf" },
  6: { title: "City of Tempe, Economic Impact Report", url: "https://tempe.gov/home/showpublisheddocument/97513/637952075762670000" },
  7: { title: "TÜİK 2023 Arz-Kullanım ve Simetrik Girdi-Çıktı Tabloları bülteni (yansı)", url: "https://www.alomaliye.com/2025/09/01/arz-ve-kullanim-tablolari-girdi-cikti-tablolari-2023/" },
  8: { title: "Flegg ve ark. (2021), Journal of Economic Structures", url: "https://doi.org/10.1186/s40008-021-00242-8" },
  9: { title: "Miller & Blair çarpan özeti (MIT OCW)", url: "https://ocw.mit.edu/courses/11-481j-analyzing-and-accounting-for-regional-economic-growth-spring-2009/57831bde2e4d1e4bf6c9dbeb3c11cf48_MIT11_481Js09_lec19a.pdf" },
  10: { title: "SurveyMonkey, NPS tanımı ve formülü", url: "https://uk.surveymonkey.com/learn/customer-feedback/net-promoter-score-definition-formula/" },
  11: { title: "TÜİK 2025 Turizm İstatistikleri (yansı)", url: "https://www.alomaliye.com/2026/01/30/2025-turizm-geliri-yuzde-6-8-artti-ziyaretci-sayisi-63-9-milyon/" },
  13: { title: "European Environment Agency, European Air Quality Index (bands, hourly concentrations)", url: "https://airindex.eea.europa.eu/AQI", note: "platform eki" },
  14: { title: "Open-Meteo, Air Quality API (Copernicus CAMS)", url: "https://open-meteo.com/en/docs/air-quality-api", note: "platform eki" },
  15: { title: "YouTube Data API v3, videos.list (statistics)", url: "https://developers.google.com/youtube/v3/docs/videos/list", note: "platform eki" },
  12: { title: "UK Government, Local economic impacts from cultural sector investments", url: "https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/638888/Local_economic_impacts_from_cultural_sector_investments.pdf" },
};

export const KPI_GROUPS = [
  { key: "registration", title: "Kayıt ve pazarlama" },
  { key: "attendance", title: "Katılım ve etkileşim" },
  { key: "experience", title: "Deneyim ve içerik" },
  { key: "finance", title: "Finans" },
  { key: "operations", title: "Operasyon" },
  { key: "business", title: "Stant, sponsor, networking ve iş çıktıları" },
  { key: "virtual", title: "Sanal, hibrit ve uygulama" },
  { key: "brand", title: "Marka, NLP, geo ve sürdürülebilirlik" },
  { key: "visitor_spend", title: "Ekonomik etki — ziyaretçi ve harcama" },
  { key: "net_injection", title: "Ekonomik etki — atfedilebilir net enjeksiyon" },
  { key: "input_output", title: "Ekonomik etki — girdi-çıktı (I-O) modeli" },
  { key: "data_quality", title: "Veri kalitesi" },
] as const;
export type KpiGroup = (typeof KPI_GROUPS)[number]["key"];

/** Where the inputs would come from; "platform" = collected by this app today. */
export type DataNeed =
  | "tickets" | "checkin" | "survey" | "tasks" | "profile"
  | "email" | "web" | "registration_form" | "sessions" | "engagement" | "finance" | "sponsors" | "leads"
  | "virtual" | "app" | "social" | "media" | "nlp" | "geo" | "sustainability" | "io_tables" | "operations_log" | "air" | "video";

export interface KpiDefinition {
  id: string;
  group: KpiGroup;
  name: string;
  formula: string;
  evidence: Evidence[];
  refs?: number[];
  /** What the T part of the evidence decides (method choice that must be stated in reports). */
  decision?: string;
  /** "platform": not in the organization's reference document; added by the platform with its own sources. */
  origin?: "platform";
  unit: "%" | "count" | "TRY" | "score" | "minutes" | "days" | "ratio" | "kg" | "kgCO2e" | "index" | "nights" | "persons" | "ugm3";
  needs: DataNeed[];
  /** Computed by src/lib/kpi/engine.ts from data the platform collects. */
  computable: boolean;
}

const d = (
  id: string, group: KpiGroup, name: string, formula: string, evidence: Evidence[], unit: KpiDefinition["unit"], needs: DataNeed[],
  computable = false, extra: Partial<Pick<KpiDefinition, "refs" | "decision" | "origin">> = {},
): KpiDefinition => ({ id, group, name, formula, evidence, unit, needs, computable, ...extra });

export const KPI_CATALOG: readonly KpiDefinition[] = [
  // 3.1 Kayıt ve pazarlama
  d("registered_count", "registration", "Kayıtlı kişi sayısı", "count_distinct(registration_id)", ["S"], "count", ["tickets"], true),
  d("email_delivery_rate", "registration", "E-posta teslim oranı", "teslim edilen / gönderilen × 100", ["S"], "%", ["email"], true),
  d("email_bounce_rate", "registration", "E-posta geri dönme oranı", "bounce / gönderilen × 100", ["S"], "%", ["email"], true),
  d("email_open_rate", "registration", "E-posta açılma oranı", "tekil açılma / teslim edilen × 100 (gizlilik proxy'leri şişirir; tıklamayı birincil al)", ["S"], "%", ["email"], true),
  d("email_click_rate", "registration", "E-posta tıklama oranı", "tekil tıklama / teslim edilen × 100", ["S"], "%", ["email"], true),
  d("click_to_open_rate", "registration", "Açılandan tıklama oranı", "tekil tıklama / tekil açılma × 100", ["S"], "%", ["email"], true),
  d("landing_page_conversion_rate", "registration", "Açılış sayfası dönüşümü", "sayfadan kayıt / tekil ziyaretçi × 100", ["S"], "%", ["web"], true),
  d("registration_completion_rate", "registration", "Kayıt tamamlama oranı", "tamamlanan kayıt / başlatılan kayıt × 100", ["S"], "%", ["registration_form"], true),
  d("cancellation_rate", "registration", "İptal oranı", "iptal / kayıtlı × 100", ["S"], "%", ["tickets"], true),
  d("no_show_rate", "registration", "Gelmeyen oranı (no-show)", "(kayıtlı − gelen kayıtlı) / kayıtlı × 100", ["K"], "%", ["tickets", "checkin"], true, { refs: [1] }),
  d("walk_in_share", "registration", "Kayıtsız gelen payı", "walk-in / gelen × 100", ["S"], "%", ["checkin", "registration_form"], true),
  d("early_bird_share", "registration", "Erken kayıt payı", "erken kayıt / kayıtlı × 100", ["S"], "%", ["registration_form"], true),
  d("waitlist_conversion_rate", "registration", "Bekleme listesi dönüşümü", "bekleme listesinden dönen / bekleme listesi × 100", ["S"], "%", ["registration_form"], true),
  d("capacity_utilization", "registration", "Kapasite kullanımı", "gelen / mekan kapasitesi × 100", ["S"], "%", ["checkin", "profile"], true),
  d("registration_lead_time_avg_days", "registration", "Ortalama kayıt öne zamanı", "ortalama(etkinlik başlangıcı − kayıt tarihi), gün", ["S"], "days", ["tickets", "profile"], true),
  d("registration_channel_share", "registration", "Kayıt kanalı payı", "kanal başına kayıt / toplam kayıt × 100", ["S"], "%", ["registration_form"]),
  d("cost_per_registration", "registration", "Kayıt başı maliyet", "pazarlama harcaması / kayıtlı", ["S"], "TRY", ["finance", "tickets"], true),

  // 3.2 Katılım ve etkileşim
  d("attended_count", "attendance", "Gelen (doğrulanmış katılımcı)", "count_distinct(geçerli check-in kişi id)", ["K"], "count", ["checkin"], true, { refs: [1] }),
  d("attendance_rate", "attendance", "Katılım oranı", "gelen / kayıtlı × 100 (walk-in payda dışındaysa 100'ü aşabilir)", ["K"], "%", ["tickets", "checkin"], true, { refs: [1] }),
  d("unique_visitor_estimate", "attendance", "Tekil ziyaretçi tahmini", "kimlikli sayımda tekil id; kimliksiz sayımda toplam giriş / tekrar ziyaret düzeltmesi (≥1)", ["T"], "persons", ["checkin", "survey"], false, { decision: "Kimliksiz sayımda tekrar ziyaret düzeltmesinin nasıl ölçüleceği" }),
  d("session_attendance_rate", "attendance", "Oturum katılım oranı", "oturum check-in / oturum kaydı × 100 (oturum bazlı)", ["S"], "%", ["sessions"], true),
  d("session_fill_rate", "attendance", "Oturum doluluk oranı", "oturum check-in / oturum kapasitesi × 100", ["K"], "%", ["sessions"], true, { refs: [1] }),
  d("avg_sessions_per_attendee", "attendance", "Katılımcı başı oturum", "toplam oturum check-in / gelen", ["S"], "ratio", ["sessions", "checkin"], true),
  d("avg_session_dwell_minutes", "attendance", "Oturumda ortalama kalış", "ortalama oturumda kalış süresi, dk", ["S"], "minutes", ["sessions"]),
  d("qa_participation_rate", "attendance", "Soru-cevap katılımı", "soru-cevaba katılan / gelen × 100", ["S"], "%", ["engagement"], true),
  d("poll_response_rate", "attendance", "Anlık anket yanıt oranı", "anlık anket yanıtlayan / gelen × 100", ["S"], "%", ["engagement"], true),
  d("active_engagement_rate", "attendance", "Aktif etkileşim oranı", "≥1 etkileşim yapan / gelen × 100", ["T"], "%", ["engagement"], true, { decision: "\"Etkileşim\" tanımı yazılı olmalı" }),
  d("content_replay_rate", "attendance", "Tekrar izleme oranı", "on-demand izleyen / kayıtlı × 100", ["S"], "%", ["virtual"]),
  d("engagement_score_index", "attendance", "Etkileşim endeksi", "ortalama_katılımcı( Σ wₖ·normalize(bileşenₖ) / Σ wₖ ), 0–100", ["T"], "index", ["engagement"], false, { decision: "Bileşenler ve ağırlıkları" }),
  d("returning_attendee_rate", "attendance", "Geri dönen katılımcı oranı", "geri dönen / gelen × 100", ["S"], "%", ["survey"], true),
  d("attendee_segment_share", "attendance", "Katılımcı segment payı", "segment sayısı / toplam × 100", ["S"], "%", ["registration_form"]),
  d("international_share", "attendance", "Yurt dışı katılımcı payı", "ülke ≠ ev sahibi ülke / ülke verisi olan × 100", ["S"], "%", ["survey"], true),

  // 3.3 Deneyim ve içerik
  d("nps", "experience", "Net Tavsiye Skoru (NPS)", "(Promoter sayısı − Detractor sayısı) / geçerli yanıt × 100; Promoter 9–10, Detractor 0–6", ["K"], "score", ["survey"], true, { refs: [10, 1] }),
  d("promoter_share", "experience", "Promoter payı", "ilgili grup / geçerli yanıt × 100", ["K"], "%", ["survey"], true, { refs: [10] }),
  d("detractor_share", "experience", "Detractor payı", "ilgili grup / geçerli yanıt × 100", ["K"], "%", ["survey"], true, { refs: [10] }),
  d("nps_ci95", "experience", "NPS %95 güven aralığı", "NPS ± 1.96 × 100 × √((p + d − (p − d)²) / n); p, d oranlar (0–1)", ["S"], "score", ["survey"], true),
  d("csat", "experience", "Memnuniyet (CSAT, üst-2 kutu)", "rating ≥ 4 / geçerli rating × 100 (üst-2 kutu)", ["S", "T"], "%", ["survey"], true, { decision: "Eşik: 1–5 ölçeğinde 4 ve 5" }),
  d("overall_satisfaction", "experience", "Genel memnuniyet ortalaması", "ortalama(geçerli likert 1–5)", ["S"], "score", ["survey"], true),
  d("repeat_intent", "experience", "Tekrar gelme niyeti", "likert ≥ 4 / geçerli likert × 100", ["S"], "%", ["survey"]),
  d("venue_satisfaction", "experience", "Mekân memnuniyeti", "ortalama(geçerli likert 1–5)", ["S"], "score", ["survey"]),
  d("accessibility_satisfaction", "experience", "Erişilebilirlik memnuniyeti", "ortalama(geçerli likert 1–5)", ["S"], "score", ["survey"], true),
  d("networking_satisfaction", "experience", "Networking memnuniyeti", "ortalama(geçerli likert 1–5)", ["S"], "score", ["survey"]),
  d("content_relevance", "experience", "İçerik uygunluğu", "ortalama(geçerli likert 1–5)", ["S"], "score", ["survey"]),
  d("fnb_satisfaction", "experience", "Yeme-içme memnuniyeti", "ortalama(geçerli likert 1–5)", ["S"], "score", ["survey"]),
  d("registration_experience_satisfaction", "experience", "Kayıt deneyimi memnuniyeti", "ortalama(geçerli likert 1–5)", ["S"], "score", ["survey"]),
  d("session_satisfaction", "experience", "Oturum memnuniyeti", "ortalama(rating), session_id'ye göre", ["S"], "score", ["sessions", "survey"], true),
  d("speaker_rating_avg", "experience", "Konuşmacı puanı", "ortalama(rating), speaker_id'ye göre", ["S"], "score", ["sessions", "survey"]),
  d("knowledge_gain_self_report", "experience", "Öz-beyan bilgi kazanımı", "ortalama(sonra − önce), eşleşen katılımcılarda (öz-beyan, test başarımı değil)", ["S"], "score", ["survey"]),
  d("complaint_rate_per_1000", "experience", "1.000 katılımcı başına şikâyet", "şikâyet / gelen × 1000", ["S"], "ratio", ["operations_log", "checkin"], true),
  d("issue_resolution_avg_minutes", "experience", "Ortalama sorun çözüm süresi", "ortalama(çözüm zamanı − bildirim zamanı), dk", ["S"], "minutes", ["operations_log"], true),

  // 3.4 Finans
  d("ticket_revenue", "finance", "Bilet geliri", "Σ net geçerli bilet satışı", ["S"], "TRY", ["finance"], true),
  d("sponsorship_revenue", "finance", "Sponsorluk geliri", "Σ net sözleşme bedeli", ["S"], "TRY", ["finance"], true),
  d("exhibitor_revenue", "finance", "Stant geliri", "Σ net stant bedeli", ["S"], "TRY", ["finance"], true),
  d("total_revenue", "finance", "Toplam gelir", "bilet + sponsorluk + stant + diğer", ["S"], "TRY", ["finance"], true),
  d("total_organizer_cost", "finance", "Toplam organizatör maliyeti", "Σ uygun maliyet kalemleri", ["S"], "TRY", ["finance"], true),
  d("net_profit", "finance", "Net kâr", "toplam gelir − toplam maliyet", ["S"], "TRY", ["finance"], true),
  d("event_roi", "finance", "Etkinlik ROI", "(Etkinlik Değeri − Etkinlik Maliyeti) / Etkinlik Maliyeti × 100", ["K", "T"], "%", ["finance"], true, { refs: [1], decision: "\"Değer\": finansal ROI için net gelir, kurumsal ROI için atfedilen gelir" }),
  d("cost_per_attendee", "finance", "Katılımcı başı maliyet", "toplam maliyet / gelen", ["K"], "TRY", ["finance", "checkin"], true, { refs: [1] }),
  d("revenue_per_attendee", "finance", "Katılımcı başı gelir", "toplam gelir / gelen", ["S"], "TRY", ["finance", "checkin"], true),
  d("avg_ticket_price", "finance", "Ortalama bilet fiyatı", "bilet geliri / ücretli bilet adedi", ["S"], "TRY", ["finance", "tickets"], true),
  d("refund_rate", "finance", "İade oranı", "iade tutarı / brüt bilet geliri × 100", ["S"], "%", ["finance"], true),
  d("discount_rate", "finance", "İndirim oranı", "indirim tutarı / brüt bilet geliri × 100", ["S"], "%", ["finance"], true),
  d("budget_variance_pct", "finance", "Bütçe sapması", "(gerçekleşen − bütçe) / bütçe × 100 (pozitif = aşım)", ["S"], "%", ["finance"], true),
  d("break_even_attendees", "finance", "Başabaş katılımcı sayısı", "yukarı yuvarla( sabit maliyet / (ort. bilet fiyatı − katılımcı başı değişken maliyet) ); marj ≤ 0 ise başabaş yok", ["S"], "persons", ["finance"], true),
  d("cost_per_lead", "finance", "Lead başı maliyet", "lead programı maliyeti / lead sayısı", ["S"], "TRY", ["finance", "leads"], true),
  d("sponsor_roi", "finance", "Sponsor ROI", "(sponsora atfedilen değer − sponsor maliyeti) / sponsor maliyeti × 100", ["T"], "%", ["sponsors"], true, { decision: "Atfedilen değer sponsorla önceden anlaşılmalı" }),
  d("sponsor_renewal_rate", "finance", "Sponsor yenileme oranı", "yenileyen sponsor / önceki yıl sponsor × 100", ["S"], "%", ["sponsors"], true),
  d("sponsor_cpm", "finance", "Sponsor CPM", "sponsorluk maliyeti / gösterim × 1000", ["S"], "TRY", ["sponsors", "social"], true),

  // 3.5 Operasyon
  d("checkin_avg_minutes", "operations", "Ortalama check-in süresi", "ortalama(check-in bitiş − kuyruk başlangıcı), dk", ["S"], "minutes", ["operations_log"], true),
  d("checkin_p90_minutes", "operations", "Check-in süresi (90. yüzdelik)", "aynı farkın 90. yüzdeliği", ["S"], "minutes", ["operations_log"], true),
  d("checkin_throughput_per_desk_hour", "operations", "Tezgâh-saat başı check-in", "check-in sayısı / (tezgâh sayısı × hizmet saati)", ["S"], "ratio", ["checkin", "operations_log"]),
  d("attendees_per_staff", "operations", "Personel başı katılımcı", "gelen / personel", ["S"], "ratio", ["checkin", "operations_log"], true),
  d("incident_rate_per_1000", "operations", "1.000 katılımcı başına olay", "olay sayısı / gelen × 1000", ["S"], "ratio", ["operations_log", "checkin"], true),
  d("badge_reprint_rate", "operations", "Rozet yeniden basım oranı", "yeniden basım / basılan rozet × 100", ["S"], "%", ["operations_log"], true),
  d("vendor_on_time_rate", "operations", "Tedarikçi zamanında teslim", "zamanında teslim / toplam teslim × 100", ["S"], "%", ["operations_log"], true),
  d("schedule_adherence_rate", "operations", "Programa uyum", "zamanında başlayan oturum / toplam oturum × 100", ["S"], "%", ["sessions"], true),
  d("task_on_time_rate", "operations", "Zamanında tamamlanan görev oranı", "vadesinde biten görev / vadesi gelen görev × 100", ["S"], "%", ["tasks"], true),
  d("survey_response_rate", "operations", "Anket yanıt oranı", "tamamlanan geçerli yanıt / davet edilen tekil kişi × 100", ["S"], "%", ["survey", "email"]),
  d("survey_completion_rate", "operations", "Anket tamamlama oranı", "tamamlanan oturum / başlatılan oturum × 100", ["S"], "%", ["survey"]),

  // 3.6 Stant, sponsor, networking ve iş çıktıları
  d("leads_count", "business", "Lead sayısı", "count_distinct(izinli nitelikli lead id)", ["S"], "count", ["leads"], true),
  d("avg_leads_per_exhibitor", "business", "Stant başı lead", "lead / stant sayısı", ["S"], "ratio", ["leads"], true),
  d("lead_qualification_rate", "business", "Lead nitelik oranı", "nitelikli lead / yakalanan lead × 100", ["S"], "%", ["leads"], true),
  d("booth_visit_rate", "business", "Stant ziyaret oranı", "tekil stant ziyaretçisi / gelen × 100", ["S"], "%", ["leads", "checkin"]),
  d("avg_booth_dwell_minutes", "business", "Standa ortalama kalış", "ortalama stant kalış süresi, dk", ["S"], "minutes", ["leads"], true),
  d("exhibitor_nps", "business", "Katılımcı firma NPS", "NPS formülü, katılımcı firma yanıtlarıyla", ["K"], "score", ["survey"], false, { refs: [10] }),
  d("new_contacts_avg", "business", "Ortalama yeni bağlantı", "ortalama(bildirilen yeni bağlantı)", ["S"], "ratio", ["survey"]),
  d("meeting_completion_rate", "business", "Toplantı gerçekleşme oranı", "gerçekleşen / planlanan toplantı × 100", ["S"], "%", ["engagement"], true),
  d("meetings_per_attendee", "business", "Katılımcı başı toplantı", "gerçekleşen toplantı / gelen", ["S"], "ratio", ["engagement", "checkin"], true),
  d("connection_rate", "business", "Bağlantı kurma oranı", "≥1 bağlantı kuran / gelen × 100", ["S"], "%", ["engagement"]),
  d("lead_to_opportunity_rate", "business", "Lead'den fırsata dönüşüm", "fırsat sayısı / lead sayısı × 100", ["S"], "%", ["leads"], true),
  d("pipeline_influenced", "business", "Etkilenen satış hattı", "Σ fırsat değeri", ["S"], "TRY", ["leads"], true),
  d("attributed_closed_won_revenue", "business", "Atfedilen kazanılmış gelir", "Σ kazanılmış gelir (atıf penceresi ve çoklu-temas kuralı gerekli)", ["T"], "TRY", ["leads"], true, { decision: "Atıf penceresi ve çoklu-temas kuralı" }),
  d("attributed_revenue_roi", "business", "Atfedilen gelir ROI", "(atfedilen kazanılmış gelir − program maliyeti) / program maliyeti × 100", ["T"], "%", ["leads", "finance"], true),
  d("cost_per_opportunity", "business", "Fırsat başı maliyet", "program maliyeti / fırsat sayısı", ["S"], "TRY", ["leads", "finance"], true),

  // 3.7 Sanal, hibrit ve uygulama
  d("virtual_attendance_rate", "virtual", "Sanal katılım oranı", "canlı izleyen / sanal kayıtlı × 100", ["S"], "%", ["virtual"], true),
  d("avg_watch_minutes", "virtual", "Ortalama izleme süresi", "ortalama izleme süresi, dk", ["S"], "minutes", ["virtual"], true),
  d("avg_watch_completion", "virtual", "Ortalama izleme tamamlama", "ortalama( min(izleme dk / içerik süresi, 1) ) × 100", ["S"], "%", ["virtual"]),
  d("peak_concurrent_viewers", "virtual", "En yüksek eşzamanlı izleyici", "max(eşzamanlı izleyici zaman serisi)", ["S"], "count", ["virtual"], true),
  d("hybrid_in_person_share", "virtual", "Hibritte yüz yüze payı", "yüz yüze / (yüz yüze + sanal) × 100", ["S"], "%", ["virtual", "checkin"]),
  d("chat_messages_per_viewer", "virtual", "İzleyici başı sohbet mesajı", "sohbet mesajı / canlı izleyen", ["S"], "ratio", ["virtual"]),
  d("app_adoption_rate", "virtual", "Uygulama benimseme", "uygulamayı aktif kullanan / gelen × 100", ["K"], "%", ["app", "checkin"], false, { refs: [1] }),
  d("app_feature_usage_rate", "virtual", "Özellik kullanım oranı", "özelliği kullanan / aktif uygulama kullanıcısı × 100", ["S"], "%", ["app"]),
  d("app_sessions_per_user", "virtual", "Kullanıcı başı uygulama oturumu", "uygulama oturumu / aktif kullanıcı", ["S"], "ratio", ["app"]),

  // 3.8 Marka, NLP, geo ve sürdürülebilirlik
  d("social_reach", "brand", "Sosyal medya erişimi", "sağlayıcının raporladığı reach, platform/kapsam bazında. Platformlar arası toplama (tekil kişi değildir)", ["T"], "count", ["social"], true),
  d("social_engagement_rate", "brand", "Sosyal medya etkileşim oranı", "tanımlı etkileşim aksiyonu / reach × 100 (payda ve tanım raporda yazılı)", ["T"], "%", ["social"], true),
  d("media_coverage_count", "brand", "Basında yer alma", "count_distinct(doğrulanmış basın kupürü)", ["S"], "count", ["media"], true),
  d("website_traffic_uplift", "brand", "Web trafiği artışı", "(etkinlik dönemi oturum − baz oturum) / baz oturum × 100", ["S"], "%", ["web"], true),
  d("social_mentions_count", "brand", "Sosyal medyada anılma", "Σ anma", ["S"], "count", ["social"], true),
  d("feedback_sentiment_share", "brand", "Geri bildirim duygu payı", "etiket sayısı / sınıflanan toplam × 100 (Türkçe için elle kalite testi)", ["S"], "%", ["nlp"]),
  d("net_sentiment_score", "brand", "Net duygu skoru", "%pozitif − %negatif", ["S"], "score", ["nlp"]),
  d("feedback_theme_share", "brand", "Geri bildirim tema payı", "temalı yanıt / kodlanan yanıt × 100 (çok etiketli; toplam %100 olmayabilir)", ["S"], "%", ["nlp"]),
  d("nearby_poi_density", "brand", "Yakın ilgi noktası yoğunluğu", "tekil geçerli POI / erişilebilir alan km² (insan yoğunluğu değildir)", ["S"], "ratio", ["geo"]),
  d("waste_per_attendee_kg", "brand", "Katılımcı başı atık", "toplam atık kg / gelen", ["S"], "kg", ["sustainability", "checkin"], true),
  d("recycling_rate", "brand", "Geri dönüşüm oranı", "geri dönüşüme giden kg / toplam atık kg × 100", ["S"], "%", ["sustainability"], true),
  d("local_sourcing_share", "brand", "Yerel tedarik payı", "yerel tedarikçi harcaması / toplam tedarikçi harcaması × 100", ["S"], "%", ["finance"]),
  d("carbon_footprint_kgco2e", "brand", "Karbon ayak izi", "Σ(faaliyet miktarı × emisyon faktörü). Faktör kaynağı, yılı ve kapsam sürümlenmeli", ["S", "T"], "kgCO2e", ["sustainability"], true, { decision: "Emisyon faktörü kaynağı, yılı ve kapsamı" }),
  d("carbon_per_attendee_kgco2e", "brand", "Katılımcı başı karbon", "karbon ayak izi / gelen", ["S"], "kgCO2e", ["sustainability", "checkin"], true),
  // Platform additions (not in the document): air quality during the event and YouTube counts
  d("air_quality_good_fair_share", "brand", "Hava kalitesi iyi/makul saat payı", "AB Hava Kalitesi İndeksi 'iyi' veya 'makul' olan etkinlik saati / veri olan etkinlik saati × 100; saatin indeksi = PM2.5, PM10, O3, NO2, SO2 saatlik konsantrasyonlarından en kötü bant", ["K", "T"], "%", ["air"], true, { refs: [13, 14], origin: "platform", decision: "Etkinlik saatleri = profildeki günlük başlangıç–bitiş (yoksa günün tamamı); model verisi (CAMS), istasyon ölçümü değil" }),
  d("air_quality_worst_level", "brand", "En kötü hava kalitesi seviyesi", "max(saatlik AB Hava Kalitesi İndeksi seviyesi), 1 = iyi … 6 = aşırı kötü", ["K", "T"], "index", ["air"], true, { refs: [13, 14], origin: "platform", decision: "Etkinlik saatleri ve model verisi" }),
  d("pm25_event_mean", "brand", "Etkinlik boyunca ortalama PM2.5", "ortalama(saatlik PM2.5), µg/m³, etkinlik saatleri", ["S"], "ugm3", ["air"], true, { refs: [14], origin: "platform" }),
  d("youtube_views", "brand", "YouTube izlenmesi", "Σ izlenme (YouTube'un bildirdiği), seçili videolar", ["S"], "count", ["video"], true, { refs: [15], origin: "platform" }),
  d("youtube_engagement_rate", "brand", "YouTube etkileşim oranı", "(beğeni + yorum) / izlenme × 100", ["S", "T"], "%", ["video"], true, { refs: [15], origin: "platform", decision: "Payda izlenmedir (YouTube erişim bildirmez)" }),

  // 3.9 Ekonomik etki — ziyaretçi ve harcama
  d("nonlocal_share", "visitor_spend", "Şehir dışı ziyaretçi payı", "ağırlıklı pay(ikamet şehri ≠ ev sahibi şehir)", ["S"], "%", ["survey"], true),
  d("event_primary_purpose_share", "visitor_spend", "Ana neden etkinlik olanların payı", "ağırlıklı pay(ana geliş nedeni = etkinlik)", ["S"], "%", ["survey"], true),
  d("would_visit_anyway_share", "visitor_spend", "Etkinlik olmasa da gelecek olanlar", "ağırlıklı pay(etkinlik olmasa da gelirdi = evet)", ["S"], "%", ["survey"], true),
  d("avg_daily_spend", "visitor_spend", "Kişi başı günlük harcama", "ağırlıklı ortalama(geçerli günlük harcama, ≥ 0)", ["S"], "TRY", ["survey"], true),
  d("accommodation_spend_per_visitor", "visitor_spend", "Ziyaretçi başı konaklama harcaması", "ağırlıklı ortalama(kategori harcaması)", ["S"], "TRY", ["survey"], true),
  d("food_spend_per_visitor", "visitor_spend", "Ziyaretçi başı yeme-içme harcaması", "ağırlıklı ortalama(kategori harcaması)", ["S"], "TRY", ["survey"], true),
  d("local_transport_spend_per_visitor", "visitor_spend", "Ziyaretçi başı şehir içi ulaşım harcaması", "ağırlıklı ortalama(kategori harcaması)", ["S"], "TRY", ["survey"], true),
  d("shopping_spend_per_visitor", "visitor_spend", "Ziyaretçi başı alışveriş harcaması", "ağırlıklı ortalama(kategori harcaması)", ["S"], "TRY", ["survey"], true),
  d("entertainment_spend_per_visitor", "visitor_spend", "Ziyaretçi başı eğlence-kültür harcaması", "ağırlıklı ortalama(kategori harcaması)", ["S"], "TRY", ["survey"], true),
  d("other_spend_per_visitor", "visitor_spend", "Ziyaretçi başı diğer harcama", "ağırlıklı ortalama(kategori harcaması)", ["S"], "TRY", ["survey"], true),
  d("spend_per_visitor", "visitor_spend", "Ziyaretçi başı yerel harcama", "ağırlıklı ortalama(örtüşmeyen yerel harcama bileşenlerinin toplamı). Bilet ve organizatör harcamasını bu toplama koyma (çift sayım)", ["S"], "TRY", ["survey"], true),
  d("accommodation_use_rate", "visitor_spend", "Konaklama yapanların payı", "ağırlıklı pay(geceleme = evet)", ["S"], "%", ["survey"], true),
  d("avg_nights_stayed", "visitor_spend", "Ortalama geceleme", "ağırlıklı ortalama(gece sayısı), geceleme = evet", ["S"], "nights", ["survey"], true),
  d("gross_visitor_spend", "visitor_spend", "Brüt ziyaretçi harcaması", "Σ_segment( ziyaretçi sayısı × ortalama harcama )", ["S"], "TRY", ["survey", "checkin"], true),
  d("total_visitor_nights", "visitor_spend", "Toplam ziyaretçi gecelemesi", "Σ_segment( ziyaretçi × geceleme payı × ortalama gece )", ["S"], "nights", ["survey", "checkin"], true),
  d("total_visitor_days", "visitor_spend", "Toplam ziyaretçi günü", "Σ_segment( ziyaretçi × ortalama gün )", ["S"], "days", ["survey", "checkin"], true),
  d("spend_per_visitor_day", "visitor_spend", "Ziyaretçi-günü başı harcama", "brüt ziyaretçi harcaması / toplam ziyaretçi günü", ["S"], "TRY", ["survey", "checkin"], true),
  d("vendor_revenue_change", "visitor_spend", "Yerel esnaf satış değişimi", "(etkinlik dönemi satış − karşılaştırılabilir baz satış) / baz satış × 100", ["S", "T"], "%", ["survey"], true, { decision: "Baz dönem seçimi" }),
  d("additional_staff", "visitor_spend", "Ek personel", "Σ etkinlik nedeniyle işe alınan ek personel", ["S"], "persons", ["survey"], true),

  // 3.10 Ekonomik etki — atfedilebilir net enjeksiyon
  d("attributable_fraction", "net_injection", "Atfedilebilir oran", "ağırlıklı pay(şehir dışı ve ana neden = etkinlik ve \"etkinlik olmasa gelmezdi\") — katı kural", ["T"], "%", ["survey"], true, { decision: "Katı kural (kısmi kredi yok); duyarlılık analizi sonra" }),
  d("attributable_visitor_spend", "net_injection", "Atfedilebilir ziyaretçi harcaması", "Σ_segment( uygun harcama × atfedilebilir oran ), oran 0–1", ["K", "T"], "TRY", ["survey", "checkin"], true, { refs: [4, 12], decision: "Uygun harcama ve oran kuralı" }),
  d("eligible_nonlocal_financed_local_spend", "net_injection", "Dış finansmanlı yerel organizatör harcaması", "Σ tutar, tedarikçi yerel ve finansman kaynağı dış olan organizatör maliyetleri", ["K", "T"], "TRY", ["finance"], true, { refs: [5] }),
  d("net_organizer_local_spend", "net_injection", "Net organizatör yerel harcaması", "uygun dış finansmanlı yerel harcama − yerel kaynaklı gelir − leakage düzeltmeleri", ["T"], "TRY", ["finance"]),
  d("net_direct_injection", "net_injection", "Net doğrudan enjeksiyon", "atfedilebilir ziyaretçi harcaması + net organizatör yerel harcaması − displacement düzeltmeleri", ["K", "T"], "TRY", ["survey", "finance"], false, { refs: [5, 6], decision: "Düzeltme kalemleri" }),

  // 3.11 Ekonomik etki — girdi-çıktı (I-O) modeli
  d("domestic_technical_coefficient", "input_output", "Yurt içi teknik katsayı", "A[i,j] = Z_yurtiçi[i,j] / X[j]; X[j] = 0 ise dur", ["S"], "ratio", ["io_tables"]),
  d("regional_technical_coefficient", "input_output", "Bölgesel teknik katsayı (FLQ)", "r[i,j] = A[i,j] × min(FLQ[i,j], 1); FLQ[i,j] = CILQ[i,j] × λ; CILQ[i,j] = SLQ[i] / SLQ[j] (i = j için SLQ[i]); SLQ[i] = (bölge çıktısı[i] / bölge toplam) / (ulusal çıktı[i] / ulusal toplam); λ = [log2(1 + bölge toplam / ulusal toplam)]^δ", ["K", "T"], "ratio", ["io_tables"], false, { refs: [8], decision: "δ değeri bölgeye özgü kestirilmeli" }),
  d("leontief_inverse", "input_output", "Leontief ters matrisi", "L = (I − A)⁻¹; spektral yarıçap ≥ 1 ise hesaplama geçersiz", ["K"], "ratio", ["io_tables"], false, { refs: [9] }),
  d("regional_sector_demand_basic_price", "input_output", "Bölgesel sektör talebi (baz fiyat)", "d = kategori bazlı enjeksiyon × köprü matrisi (kategori → ürün, alıcı fiyatından baz fiyata dönüşümlü)", ["T"], "TRY", ["io_tables", "survey"], false, { refs: [7], decision: "Alıcı fiyatından baz fiyata köprü" }),
  d("output_effect_vector", "input_output", "Üretim etkisi vektörü", "Δx = L_bölgesel × d", ["K"], "TRY", ["io_tables"], false, { refs: [9] }),
  d("output_multiplier", "input_output", "Üretim çarpanı", "j sektörü için L'nin j. sütun toplamı", ["K"], "ratio", ["io_tables"], false, { refs: [9] }),
  d("indirect_output_effect", "input_output", "Dolaylı üretim etkisi", "Σ Δx − Σ d (doğrudan çıktı = nihai talep toplamı)", ["K", "T"], "TRY", ["io_tables"], false, { refs: [9] }),
  d("gva_effect", "input_output", "Katma değer etkisi", "Σᵢ( katma değer katsayısıᵢ × Δxᵢ )", ["S"], "TRY", ["io_tables"]),
  d("employment_effect", "input_output", "İstihdam etkisi", "Σᵢ( Δxᵢ / 1.000.000 × milyon TL başına istihdam katsayısıᵢ ), FTE", ["S", "T"], "persons", ["io_tables"], false, { decision: "İstihdam katsayısı kaynağı" }),
  d("induced_effect", "input_output", "Uyarılmış etki (Tip II)", "hanehalkı kapalı model (Tip II) etkisi − Tip I etkisi", ["K", "T"], "TRY", ["io_tables"], false, { refs: [9], decision: "Kapanış yöntemi; varsayılan kapalı" }),
  d("total_output_impact", "input_output", "Toplam üretim etkisi", "Σ d + dolaylı + uyarılmış", ["S"], "TRY", ["io_tables"]),
  d("effective_multiplier", "input_output", "Etkin çarpan", "toplam üretim etkisi / Σ d", ["S"], "ratio", ["io_tables"]),
  d("economic_return_per_public_try", "input_output", "Kamu TL'si başına ekonomik getiri", "GVA etkisi / kamu finansmanı", ["T"], "ratio", ["io_tables", "finance"]),

  // 3.12 Veri kalitesi
  d("effective_sample_size", "data_quality", "Etkin örneklem büyüklüğü (Kish)", "(Σw)² / Σw²", ["S"], "count", ["survey"], true),
  d("survey_margin_of_error", "data_quality", "Anket hata payı", "1.96 × √(p(1−p)/n) × √((N−n)/(N−1)) × 100; p = 0.5 en kötü durum", ["S"], "%", ["survey", "checkin"], true),
];

export const KPI_BY_ID: ReadonlyMap<string, KpiDefinition> = new Map(KPI_CATALOG.map((k) => [k.id, k]));

/** Inputs that come from outside services or uploads: an organization may not have them connected. */
const EXTERNAL_NEEDS: readonly DataNeed[] = ["email", "web", "social", "media", "sponsors", "leads", "air", "video"];

/**
 * A computed metric fed by external data: the engine's value wins, but while no source delivers one (value null)
 * the organizer may enter the actual by hand (KPI page), labelled as manual.
 */
export const allowsManualFallback = (id: string) =>
  (DATASET_KPI_IDS as readonly string[]).includes(id) || !!KPI_BY_ID.get(id)?.needs.some((n) => EXTERNAL_NEEDS.includes(n));

/** The metric library's KPI keys (proposals, event_kpis.metric_name) → catalog ids computed by the engine. */
export const LIBRARY_TO_CATALOG: Record<string, string> = {
  registrations_confirmed: "registered_count",
  show_up_rate: "attendance_rate",
  overall_satisfaction: "overall_satisfaction",
  nps: "nps",
  accessibility_satisfaction: "accessibility_satisfaction",
  repeat_attendance_rate: "returning_attendee_rate",
  visitor_share: "nonlocal_share",
  mean_spend_per_visitor_day: "spend_per_visitor_day",
  mean_nights_stayed: "avg_nights_stayed",
  attributable_visitor_spend: "attributable_visitor_spend",
  task_on_time_rate: "task_on_time_rate",
  cost_per_attendee: "cost_per_attendee",
  budget_variance: "budget_variance_pct",
  social_engagement_rate: "social_engagement_rate",
  press_mentions: "media_coverage_count",
  incidents_per_10k: "incident_rate_per_1000",
};

export const DATA_NEED_LABEL: Record<DataNeed, string> = {
  tickets: "biletler", checkin: "check-in", survey: "anket", tasks: "görevler", profile: "etkinlik profili",
  email: "e-posta gönderim verisi", web: "web analitiği", registration_form: "kayıt formu", sessions: "oturum programı",
  engagement: "etkileşim verisi", finance: "bütçe ve gelir-gider", sponsors: "sponsor verisi", leads: "lead verisi",
  virtual: "yayın verisi", app: "mobil uygulama verisi", social: "sosyal medya verisi", media: "basın takibi",
  nlp: "metin sınıflandırma", geo: "harita verisi", sustainability: "atık ve enerji verisi", io_tables: "TÜİK girdi-çıktı tabloları",
  operations_log: "operasyon kayıtları", air: "hava kalitesi verisi (Open-Meteo)", video: "video platformu verisi",
};
