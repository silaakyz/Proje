/** Turkish labels for backend enum values. Every visible word in the UI is Turkish. */
import { METRIC_LIBRARY } from "@/lib/metrics/library";
import { MODULES } from "@/lib/modules/registry";
import type { EventStatus, ImpactLevel, OrganizerType, ProposalStatus, Role, SurveyStatus, TaskStatus } from "@/lib/api/types";

export const ROLE_LABEL: Record<Role, string> = { owner: "KURUM SAHİBİ", admin: "YÖNETİCİ", staff: "EKİP ÜYESİ" };
export const ROLE_NAME: Record<Role, string> = { owner: "Kurum sahibi", admin: "Yönetici", staff: "Ekip üyesi" };

export const ORGANIZER_TYPE_OPTIONS: { value: OrganizerType; label: string }[] = [
  { value: "MUNICIPALITY", label: "Belediye" },
  { value: "PUBLIC_INSTITUTION", label: "Kamu kurumu" },
  { value: "UNIVERSITY", label: "Üniversite" },
  { value: "COMPANY", label: "Şirket" },
  { value: "EVENT_AGENCY", label: "Etkinlik ajansı" },
  { value: "NONPROFIT", label: "Sivil toplum kuruluşu" },
  { value: "OTHER", label: "Diğer" },
];

/** Badge text per event status (the badge component derives its colour class from it). */
export const EVENT_STATUS_BADGE: Record<EventStatus, string> = { draft: "TASLAK", live: "CANLI", completed: "TAMAMLANDI" };
export const EVENT_STATUS_LABEL: Record<EventStatus, string> = { draft: "Taslak", live: "Canlı", completed: "Tamamlandı" };

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { TODO: "Yapılacak", IN_PROGRESS: "Sürüyor", DONE: "Tamamlandı" };
export const TASK_BOARD_LABEL: Record<string, string> = { PLANNING: "Planlama", OPERATIONS: "Operasyon", MEASUREMENT: "Ölçüm" };
export const PRIORITY_LABEL: Record<string, string> = { CRITICAL: "Kritik", HIGH: "Yüksek", MEDIUM: "Orta", LOW: "Düşük" };
export const PHASE_LABEL: Record<string, string> = {
  PLAN: "Planla", PREPARE: "Hazırla", MANAGE: "Yönet", RUN: "Uygula", ANALYZE: "Analiz et", IMPROVE: "Geliştir",
};

const WORKSTREAMS = new Map<string, string>(MODULES.flatMap((m) => m.workstreams.map((w) => [w.key, w.label] as const)));
export const workstreamLabel = (key: string | null) => (key ? WORKSTREAMS.get(key) ?? key : "Genel");
const MODULE_LABELS = new Map<string, string>(MODULES.map((m) => [m.key, m.label] as const));
export const moduleLabel = (key: string) => MODULE_LABELS.get(key) ?? key;
export const MODULE_OPTIONS = MODULES.filter((m) => !("core" in m && m.core)).map((m) => ({ key: m.key, label: m.label }));

const METRICS = new Map<string, { name: string; unit: string; description: string }>(
  METRIC_LIBRARY.map((m) => [m.key, { name: m.name, unit: m.unit, description: m.description }] as const),
);
export const metricInfo = (key: string) => METRICS.get(key) ?? { name: key, unit: "", description: "" };

export const KPI_STATUS_BADGE: Record<string, string> = { PROPOSED: "ÖNERİLDİ", ACTIVE: "AKTİF", DROPPED: "BIRAKILDI" };
export const KPI_SOURCE_LABEL: Record<string, string> = { survey: "Anket", ticket_sales: "Bilet", system: "Sistem" };

export const PROPOSAL_STATUS_BADGE: Record<ProposalStatus, string> = {
  PENDING: "BEKLİYOR", APPLIED: "UYGULANDI", REJECTED: "REDDEDİLDİ", FAILED: "BAŞARISIZ", EXPIRED: "SÜRESİ DOLDU",
};
export const PROPOSAL_KIND_LABEL: Record<string, string> = {
  "blueprint.core": "ETKİNLİK PROFİLİ",
  "blueprint.tasks": "GÖREVLER",
  "blueprint.kpis": "KPI VE ÖLÇÜM",
  "blueprint.surveys": "ANKETLER",
  "blueprint.registration": "KAYIT",
  "blueprint.budget_risks": "BÜTÇE VE RİSKLER",
};

export const SURVEY_STATUS_BADGE: Record<SurveyStatus, string> = { DRAFT: "TASLAK", OPEN: "AÇIK", CLOSED: "KAPALI" };
export const AUDIENCE_LABEL: Record<string, string> = {
  ATTENDEE: "Ziyaretçiler", SPONSOR: "Sponsorlar", EXHIBITOR: "Katılımcı firmalar", LOCAL_BUSINESS: "Yerel işletmeler",
  ORGANIZER: "Düzenleyici ekip", RESIDENT: "Yerel halk", PUBLIC_AUTHORITY: "Kamu kurumları",
};
export const QUESTION_TYPE_LABEL: Record<string, string> = {
  LIKERT_5: "1–5 ölçeği", rating: "1–5 ölçeği", NPS_0_10: "0–10 tavsiye", YES_NO: "Evet / hayır", boolean: "Evet / hayır",
  SINGLE_CHOICE: "Tek seçim", MULTI_CHOICE: "Çoklu seçim", NUMBER: "Sayı", PERCENT: "Yüzde", CURRENCY_TRY: "Tutar (₺)",
  PROVINCE: "İl seçimi", OPEN_TEXT: "Açık uçlu", text: "Açık uçlu",
};
export const CHANNEL_LABEL: Record<string, string> = { PUBLIC_LINK: "Bağlantı", STAFF_ENTRY: "Personel" };

export const SPEND_CATEGORY_LABEL: Record<string, string> = {
  ACCOMMODATION: "Konaklama", FOOD_BEVERAGE: "Yeme-içme", LOCAL_TRANSPORT: "Şehir içi ulaşım", INTERCITY_TRANSPORT: "Şehirlerarası ulaşım",
  RETAIL_SHOPPING: "Alışveriş", ENTERTAINMENT_CULTURE: "Eğlence ve kültür", VENUE_AND_SERVICES: "Mekân ve hizmetler",
  MARKETING_PRINTING: "Pazarlama ve baskı", OTHER: "Diğer",
};
export const SPEND_CATEGORIES = Object.keys(SPEND_CATEGORY_LABEL);

export const IMPACT_LEVEL_LABEL: Record<ImpactLevel, string> = {
  SPEND: "Harcama", ATTRIBUTABLE_SPEND: "Atfedilebilir harcama", ECONOMIC_IMPACT: "Ekonomik etki",
};
export const IMPACT_LEVELS: ImpactLevel[] = ["SPEND", "ATTRIBUTABLE_SPEND", "ECONOMIC_IMPACT"];
export const IMPACT_CHECK_LABEL: Record<string, string> = {
  attendance_known: "Katılım tabanı",
  min_spend_responses: "Harcama bildiren ziyaretçi yanıtı",
  assumptions_valid: "Fiyat yılı ve varsayım kaydı",
  attendance_measured: "Ölçülmüş katılım (tahmin değil)",
  min_attribution_responses: "Atıf sorularını yanıtlayan ziyaretçi",
  deadweight_sourced: "Ölü ağırlık (kaynaklı)",
  attribution_from_survey: "Atfedilebilirlik anketten ölçülüyor (katı kural)",
  displacement_sourced: "Yer değiştirme (kaynaklı)",
  multiplier_set_active: "Aktif çarpan seti seçildi",
  multiplier_set_matches_region: "Çarpan seti etkinlik bölgesiyle eşleşiyor",
  leakage_sourced: "Sızıntı (kaynaklı)",
  multipliers_cover_spend_categories: "Çarpan seti harcama kategorilerini kapsıyor",
  price_years_match: "İstihdam için fiyat yılı uyumu",
};
export const ATTENDANCE_BASIS_LABEL: Record<string, string> = {
  CHECKIN: "check-in", REGISTRATION: "kayıtlı bilet", ORGANIZER_ESTIMATE: "düzenleyici tahmini",
};
export const MULTIPLIER_METHOD_LABEL: Record<string, string> = {
  NATIONAL: "Ulusal tablo", SLQ: "SLQ", CILQ: "CILQ", FLQ: "FLQ", SURVEY_BASED: "Anket tabanlı",
};
export const MULTIPLIER_TYPE_LABEL: Record<string, string> = { TYPE_I: "Tip I", TYPE_II: "Tip II" };

export const EVENT_FORMAT_LABEL: Record<string, string> = {
  CONFERENCE: "Konferans", SYMPOSIUM: "Sempozyum", SUMMIT: "Zirve", CONGRESS: "Kongre", B2B_MATCHMAKING: "B2B görüşme",
  CULTURAL: "Kültür etkinliği", TRADE_FAIR: "Fuar", FESTIVAL: "Festival", CONCERT: "Konser", SPORTS: "Spor etkinliği",
  WORKSHOP: "Atölye", MEETUP: "Buluşma", EXHIBITION: "Sergi", OTHER: "Etkinlik",
};

/** NUTS-2 codes of the 26 Turkish regions, for the multiplier-set form. */
export const NUTS2_OPTIONS: { code: string; label: string }[] = [
  ["TR10", "İstanbul"], ["TR21", "Tekirdağ, Edirne, Kırklareli"], ["TR22", "Balıkesir, Çanakkale"], ["TR31", "İzmir"],
  ["TR32", "Aydın, Denizli, Muğla"], ["TR33", "Manisa, Afyon, Kütahya, Uşak"], ["TR41", "Bursa, Eskişehir, Bilecik"],
  ["TR42", "Kocaeli, Sakarya, Düzce, Bolu, Yalova"], ["TR51", "Ankara"], ["TR52", "Konya, Karaman"],
  ["TR61", "Antalya, Isparta, Burdur"], ["TR62", "Adana, Mersin"], ["TR63", "Hatay, Kahramanmaraş, Osmaniye"],
  ["TR71", "Kırıkkale, Aksaray, Niğde, Nevşehir, Kırşehir"], ["TR72", "Kayseri, Sivas, Yozgat"],
  ["TR81", "Zonguldak, Karabük, Bartın"], ["TR82", "Kastamonu, Çankırı, Sinop"], ["TR83", "Samsun, Tokat, Çorum, Amasya"],
  ["TR90", "Trabzon, Ordu, Giresun, Rize, Artvin, Gümüşhane"], ["TRA1", "Erzurum, Erzincan, Bayburt"],
  ["TRA2", "Ağrı, Kars, Iğdır, Ardahan"], ["TRB1", "Malatya, Elazığ, Bingöl, Tunceli"], ["TRB2", "Van, Muş, Bitlis, Hakkâri"],
  ["TRC1", "Gaziantep, Adıyaman, Kilis"], ["TRC2", "Şanlıurfa, Diyarbakır"], ["TRC3", "Mardin, Batman, Şırnak, Siirt"],
].map(([code, label]) => ({ code: code!, label: `${code} ${label}` }));
