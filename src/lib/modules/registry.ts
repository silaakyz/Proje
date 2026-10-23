/**
 * Modules: one platform core + configurable modules, for every event format.
 *
 * The AI never generates code for an event type. It selects modules from this registry.
 * Selection uses COMPATIBILITY rules, not an allow-list per format: a conference may have a stage,
 * a festival may have speakers and sessions. Only genuine conflicts are blocked (e.g. physical site
 * operations for a fully virtual event), and dependencies are added automatically.
 *
 * `defaultFor` and `recommendedFor` only drive defaults and suggestions; they never forbid.
 * In V0.1 a module contributes data (workstreams, metrics, stakeholder kinds, survey audiences);
 * its own screens and tables ship with `availableIn`.
 */
import type {
  DeliveryModeValue,
  EventFormatValue,
  OrganizerTypeValue,
  StakeholderKindValue,
  SurveyAudienceValue,
} from "@/lib/domain/enums";

export type Release = "V0.1" | "V0.2" | "V0.3" | "V0.4" | "V1.0";

export interface Workstream {
  key: string; // snake_case, stored in tasks.workstream / budget_lines.category
  label: string;
}

export interface ModuleDef {
  key: string;
  label: string;
  description: string;
  /** When the module's own UI ships. Its Blueprint contributions work from V0.1. */
  availableIn: Release;
  /** Always on. */
  core?: true;
  /** Enabled by default for these formats. */
  defaultFor: readonly EventFormatValue[];
  /** Suggested (never required, never exclusive) for these formats / organizer types. */
  recommendedFor: { formats: readonly EventFormatValue[]; organizerTypes: readonly OrganizerTypeValue[] };
  /** Modules this one needs; added automatically. */
  requires: readonly string[];
  /** Hard incompatibilities only. */
  incompatibleWith: { deliveryModes: readonly DeliveryModeValue[] };
  workstreams: readonly Workstream[];
  stakeholderKinds: readonly StakeholderKindValue[];
  surveyAudiences: readonly SurveyAudienceValue[];
}

const NONE = { deliveryModes: [] } as const;

export const MODULES = [
  {
    key: "core",
    label: "Planlama çekirdeği",
    description: "Hedefler, görevler, bütçe, riskler, paydaşlar, ekip.",
    availableIn: "V0.1",
    core: true,
    defaultFor: [],
    recommendedFor: { formats: [], organizerTypes: [] },
    requires: [],
    incompatibleWith: NONE,
    workstreams: [
      { key: "strategy", label: "Strateji ve hedefler" },
      { key: "venue", label: "Mekân ve alan" },
      { key: "program", label: "Program" },
      { key: "marketing", label: "Pazarlama ve iletişim" },
      { key: "logistics", label: "Lojistik ve tedarik" },
      { key: "staffing", label: "Ekip ve personel" },
      { key: "safety_security", label: "Güvenlik ve sağlık" },
      { key: "permits", label: "İzinler ve resmi yazışmalar" },
      { key: "finance", label: "Finans" },
      { key: "data_collection", label: "Veri toplama ve ölçüm" },
      { key: "reporting", label: "Raporlama" },
    ],
    stakeholderKinds: ["VENDOR", "PARTNER", "MEDIA"],
    surveyAudiences: ["ATTENDEE"],
  },
  {
    key: "registration",
    label: "Kayıt ve katılımcılar",
    description: "Kayıt formları, ücretsiz biletler, katılımcı yönetimi, QR check-in.",
    availableIn: "V0.2",
    core: true,
    defaultFor: [],
    recommendedFor: { formats: [], organizerTypes: [] },
    requires: [],
    incompatibleWith: NONE,
    workstreams: [{ key: "registration", label: "Kayıt ve bilet" }],
    stakeholderKinds: [],
    surveyAudiences: [],
  },
  {
    key: "sessions",
    label: "Oturumlar ve program akışı",
    description: "Paralel oturumlar, salonlar, oturum bazlı katılım ve değerlendirme.",
    availableIn: "V0.4",
    defaultFor: ["CONFERENCE", "SYMPOSIUM", "CONGRESS", "SUMMIT"],
    recommendedFor: { formats: ["WORKSHOP", "TRADE_FAIR"], organizerTypes: ["UNIVERSITY", "COMPANY"] },
    requires: [],
    incompatibleWith: NONE,
    workstreams: [{ key: "agenda", label: "Oturum planı" }],
    stakeholderKinds: [],
    surveyAudiences: [],
  },
  {
    key: "speakers",
    label: "Konuşmacılar ve akademik program",
    description: "Konuşmacı davetleri, bildiri çağrısı ve hakem süreci, sunum dosyaları.",
    availableIn: "V0.4",
    defaultFor: ["CONFERENCE", "SYMPOSIUM", "CONGRESS"],
    recommendedFor: { formats: ["SUMMIT", "MEETUP", "FESTIVAL", "CULTURAL"], organizerTypes: ["UNIVERSITY", "COMPANY"] },
    requires: ["sessions"],
    incompatibleWith: NONE,
    workstreams: [
      { key: "speaker_management", label: "Konuşmacı yönetimi" },
      { key: "call_for_papers", label: "Bildiri çağrısı ve değerlendirme" },
    ],
    stakeholderKinds: ["SPEAKER"],
    surveyAudiences: [],
  },
  {
    key: "stages",
    label: "Sahneler ve performanslar",
    description: "Sahne programı, sanatçı ilişkileri, teknik rider, prova takvimi.",
    availableIn: "V0.4",
    defaultFor: ["FESTIVAL", "CONCERT"],
    recommendedFor: { formats: ["CULTURAL", "SPORTS"], organizerTypes: [] },
    requires: [],
    incompatibleWith: NONE,
    workstreams: [
      { key: "stage_production", label: "Sahne ve teknik prodüksiyon" },
      { key: "artist_relations", label: "Sanatçı ilişkileri" },
    ],
    stakeholderKinds: ["ARTIST"],
    surveyAudiences: [],
  },
  {
    key: "booths",
    label: "Stantlar ve katılımcı firmalar",
    description: "Stant planı, katılımcı firma başvuruları, stant yükümlülükleri.",
    availableIn: "V0.4",
    defaultFor: ["TRADE_FAIR", "EXHIBITION"],
    recommendedFor: { formats: ["FESTIVAL", "CONFERENCE", "CONGRESS"], organizerTypes: [] },
    requires: [],
    incompatibleWith: NONE,
    workstreams: [{ key: "booth_management", label: "Stant yönetimi" }],
    stakeholderKinds: ["EXHIBITOR"],
    surveyAudiences: ["EXHIBITOR"],
  },
  {
    key: "matchmaking",
    label: "B2B görüşme eşleştirme",
    description: "Firma profilleri, eşleştirme, görüşme takvimi ve sonuç takibi.",
    availableIn: "V1.0",
    defaultFor: ["B2B_MATCHMAKING"],
    recommendedFor: { formats: ["TRADE_FAIR", "SUMMIT"], organizerTypes: [] },
    requires: ["registration"],
    incompatibleWith: NONE,
    workstreams: [{ key: "matchmaking", label: "Görüşme eşleştirme" }],
    stakeholderKinds: [],
    surveyAudiences: [],
  },
  {
    key: "sponsorship",
    label: "Sponsorluk",
    description: "Sponsor paketleri, yükümlülük takibi, sponsor raporları.",
    availableIn: "V0.4",
    defaultFor: [],
    recommendedFor: { formats: ["FESTIVAL", "CONCERT", "CONFERENCE", "CONGRESS", "SUMMIT", "SPORTS", "CULTURAL"], organizerTypes: ["COMPANY", "EVENT_AGENCY"] },
    requires: [],
    incompatibleWith: NONE,
    workstreams: [{ key: "sponsorship", label: "Sponsorluk" }],
    stakeholderKinds: ["SPONSOR"],
    surveyAudiences: ["SPONSOR"],
  },
  {
    key: "site_operations",
    label: "Saha operasyonu",
    description: "Alan bölgeleri, kapılar, vardiyalar, saha ekipleri, olay kaydı.",
    availableIn: "V0.2",
    defaultFor: ["FESTIVAL", "CONCERT", "SPORTS", "TRADE_FAIR"],
    recommendedFor: { formats: ["CULTURAL", "EXHIBITION", "CONGRESS"], organizerTypes: ["MUNICIPALITY"] },
    requires: [],
    incompatibleWith: { deliveryModes: ["VIRTUAL"] },
    workstreams: [
      { key: "site_operations", label: "Saha operasyonu" },
      { key: "crowd_management", label: "Kalabalık yönetimi" },
    ],
    stakeholderKinds: ["VOLUNTEER_GROUP"],
    surveyAudiences: [],
  },
  {
    key: "community_impact",
    label: "Toplumsal etki",
    description: "Yerel halk algısı, erişilebilirlik, kamu paydaşları; kamu kurumları için raporlama.",
    availableIn: "V0.3",
    defaultFor: [],
    recommendedFor: { formats: ["FESTIVAL", "CULTURAL", "CONCERT", "SPORTS"], organizerTypes: ["MUNICIPALITY", "PUBLIC_INSTITUTION", "NONPROFIT"] },
    requires: [],
    incompatibleWith: NONE,
    workstreams: [{ key: "community_relations", label: "Yerel halk ve kamu ilişkileri" }],
    stakeholderKinds: ["PUBLIC_AUTHORITY", "COMMUNITY"],
    surveyAudiences: ["RESIDENT", "PUBLIC_AUTHORITY"],
  },
  {
    key: "economic_impact",
    label: "Ekonomik etki",
    description: "Ziyaretçi harcaması, atfedilebilir harcama ve veri yeterse A-64 tabanlı ekonomik etki.",
    availableIn: "V0.3",
    defaultFor: [],
    recommendedFor: { formats: ["FESTIVAL", "CONGRESS", "TRADE_FAIR", "SPORTS", "CONCERT", "CULTURAL"], organizerTypes: ["MUNICIPALITY", "PUBLIC_INSTITUTION"] },
    requires: [],
    incompatibleWith: { deliveryModes: ["VIRTUAL"] },
    workstreams: [{ key: "impact_study", label: "Etki çalışması" }],
    stakeholderKinds: ["LOCAL_BUSINESS"],
    surveyAudiences: ["LOCAL_BUSINESS"],
  },
  {
    key: "social_media",
    label: "Sosyal medya ve görünürlük",
    description: "Yetkili hesaplardan erişim, etkileşim ve basın görünürlüğü ölçümü.",
    availableIn: "V1.0",
    defaultFor: [],
    recommendedFor: { formats: [], organizerTypes: [] },
    requires: [],
    incompatibleWith: NONE,
    workstreams: [{ key: "media_monitoring", label: "Medya takibi" }],
    stakeholderKinds: [],
    surveyAudiences: [],
  },
] as const satisfies readonly ModuleDef[];

export type ModuleKey = (typeof MODULES)[number]["key"];
export const MODULE_KEYS = MODULES.map((m) => m.key) as [ModuleKey, ...ModuleKey[]];

const BY_KEY = new Map<string, ModuleDef>(MODULES.map((m) => [m.key, m]));
export const getModule = (key: string): ModuleDef | undefined => BY_KEY.get(key);
const defs = (): readonly ModuleDef[] => MODULES;

export interface ModuleContext {
  format: EventFormatValue;
  deliveryMode: DeliveryModeValue;
  organizerType: OrganizerTypeValue;
}

/** Deterministic defaults: core modules + format defaults that are compatible with the delivery mode. */
export function defaultModulesFor(ctx: Pick<ModuleContext, "format" | "deliveryMode">): ModuleKey[] {
  return defs()
    .filter((m) => m.core === true || m.defaultFor.includes(ctx.format))
    .filter((m) => !m.incompatibleWith.deliveryModes.includes(ctx.deliveryMode))
    .map((m) => m.key as ModuleKey);
}

/** Suggestions shown to the organizer and the model: recommended by format OR organizer type. */
export function recommendedModulesFor(ctx: ModuleContext): ModuleKey[] {
  const defaults = new Set<string>(defaultModulesFor(ctx));
  return defs()
    .filter((m) => !defaults.has(m.key) && !m.incompatibleWith.deliveryModes.includes(ctx.deliveryMode))
    .filter((m) => m.recommendedFor.formats.includes(ctx.format) || m.recommendedFor.organizerTypes.includes(ctx.organizerType))
    .map((m) => m.key as ModuleKey);
}

export type Compatibility = { ok: true } | { ok: false; reason: string };

export function checkCompatibility(key: string, ctx: Pick<ModuleContext, "deliveryMode">): Compatibility {
  const m = getModule(key);
  if (!m) return { ok: false, reason: `unknown module '${key}'` };
  if (m.incompatibleWith.deliveryModes.includes(ctx.deliveryMode))
    return { ok: false, reason: `'${key}' is not available for ${ctx.deliveryMode} events` };
  return { ok: true };
}

export interface ModuleRequest {
  key: string;
  source: "DEFAULT" | "AI_PROPOSED" | "ORGANIZER" | "DEPENDENCY";
  reason: string | null;
}

/**
 * Resolves a module set: drops unknown/incompatible modules, requires a reason for AI proposals,
 * and adds dependencies (transitively). Order: defaults, then requests, then dependencies.
 */
export function resolveModules(
  requests: readonly ModuleRequest[],
  ctx: ModuleContext,
): { modules: (ModuleRequest & { key: ModuleKey })[]; repairs: string[] } {
  const repairs: string[] = [];
  const out: (ModuleRequest & { key: ModuleKey })[] = [];
  const has = (k: string) => out.some((m) => m.key === k);
  const add = (r: ModuleRequest) => {
    if (has(r.key)) return;
    const c = checkCompatibility(r.key, ctx);
    if (!c.ok) {
      repairs.push(`${c.reason}; dropped`);
      return;
    }
    if (r.source === "AI_PROPOSED" && !r.reason?.trim()) {
      repairs.push(`module '${r.key}' proposed without a reason; dropped`);
      return;
    }
    out.push({ ...r, key: r.key as ModuleKey });
    for (const dep of getModule(r.key)!.requires)
      if (!has(dep)) {
        repairs.push(`module '${dep}' added: required by '${r.key}'`);
        add({ key: dep, source: "DEPENDENCY", reason: `'${r.key}' modülü için gerekli` });
      }
  };
  for (const key of defaultModulesFor(ctx)) add({ key, source: "DEFAULT", reason: null });
  for (const r of requests) add(r);
  return { modules: out, repairs };
}

/** Union of everything the enabled modules contribute — the vocabulary later stages must use. */
export function vocabularyFor(modules: readonly string[]) {
  const enabled = modules.map(getModule).filter((m): m is ModuleDef => !!m);
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  return {
    workstreams: uniq(enabled.flatMap((m) => m.workstreams.map((w) => w.key))),
    workstreamLabels: Object.fromEntries(enabled.flatMap((m) => m.workstreams.map((w) => [w.key, w.label]))),
    stakeholderKinds: uniq(enabled.flatMap((m) => [...m.stakeholderKinds])),
    surveyAudiences: uniq(enabled.flatMap((m) => [...m.surveyAudiences])),
  };
}
