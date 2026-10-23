/**
 * Prompt-to-Event contract.
 *
 * Two layers, on purpose:
 *
 *  1. `eventConfigDraftSchema` — what the LLM fills via `Output.object`.
 *     Provider-safe JSON Schema: every key required, "unknown" expressed as `null`
 *     (never `.optional()`), no regex / numeric bounds (several providers reject or
 *     silently drop them), meaning carried by `.describe()` because that is what the
 *     model actually reads.
 *
 *  2. `eventConfigSchema` — the strict domain object the app persists.
 *     Produced only by `normalizeEventConfig()`, which applies deterministic repairs
 *     (slugging keys, deriving end dates, resolving the province/NUTS-2 region,
 *     injecting system + KVKK fields, raising clarifications) and then hard-validates.
 *
 * The model never decides anything that is a lookup or a legal requirement.
 */
import { z } from "zod";
import { resolveProvince, type Nuts2Code } from "@/lib/geo/tr-provinces";
import { DELIVERY_MODES, EVENT_FORMATS } from "@/lib/domain/enums";

export const EVENT_CONFIG_SCHEMA_VERSION = "event-config/v1" as const;

// ---------------------------------------------------------------------------
// Shared enums (src/lib/domain/enums.ts)
// ---------------------------------------------------------------------------

export const EventFormat = z.enum(EVENT_FORMATS);
export const DeliveryMode = z.enum(DELIVERY_MODES);
export const TicketPricing = z.enum(["FREE", "PAID", "DONATION"]);
export const Currency = z.enum(["TRY", "EUR", "USD"]);
export const FormFieldType = z.enum([
  "SHORT_TEXT", "LONG_TEXT", "EMAIL", "PHONE", "NUMBER", "DATE",
  "SINGLE_SELECT", "MULTI_SELECT", "CHECKBOX", "COUNTRY", "CITY_TR",
  "FILE_UPLOAD", "TCKN", "KVKK_CONSENT",
]);
/** SYSTEM and MANUAL exist in the DB enum but are never produced by the model. */
export const LlmFieldOrigin = z.enum(["EXPLICIT", "INFERRED"]);
export const FieldOrigin = z.enum(["SYSTEM", "EXPLICIT", "INFERRED", "MANUAL"]);

const SELECT_TYPES = new Set<z.infer<typeof FormFieldType>>(["SINGLE_SELECT", "MULTI_SELECT"]);

/** Keys the platform owns. The model is told not to emit them; if it does, they are dropped. */
export const RESERVED_FIELD_KEYS = [
  "first_name", "last_name", "email", "phone",
  "kvkk_consent", "kvkk_special_consent", "marketing_consent",
] as const;

// ---------------------------------------------------------------------------
// 1. LLM DRAFT SCHEMA
// ---------------------------------------------------------------------------

/**
 * Integers for the provider schema. `z.number().int()` serializes with min/max safe-integer
 * bounds in Zod 4, which structured-output providers reject or drop — so the draft uses a plain
 * number and the normalizer rounds.
 */
const wholeNumber = () => z.number();

export const draftOption = z.object({
  value: z.string().describe("Stable machine value, lowercase snake_case ASCII. e.g. 'vegan', 'gluten_free'."),
  label: z.string().describe("Turkish label shown to the attendee. e.g. 'Glutensiz'."),
  labelEn: z.string().nullable().describe("English label, or null if the event is Turkish-only."),
});

export const draftTicketType = z.object({
  key: z.string().describe("Stable machine key, lowercase snake_case ASCII, unique within the event. e.g. 'student_free', 'corporate'."),
  name: z.string().describe("Display name in the event's primary language. e.g. 'Öğrenci (Ücretsiz)'."),
  description: z.string().nullable().describe("One sentence, or null. Do not invent perks the user did not mention."),
  pricing: TicketPricing.describe("FREE if the user said free/ücretsiz; PAID if the user said paid/ücretli or gave a price; DONATION only if explicitly mentioned."),
  priceAmount: z.number().nullable().describe(
    "Price per ticket in MAJOR currency units including VAT (e.g. 1500 for 1.500 TL). " +
      "0 for FREE. MUST be null for PAID tickets unless the user stated a number — never estimate a price.",
  ),
  currency: Currency.describe("TRY unless the user explicitly stated another currency."),
  quantity: wholeNumber().nullable().describe("Number of tickets of this type, only if the user stated it or it follows arithmetically from what they said. Otherwise null."),
  maxPerOrder: wholeNumber().nullable().describe("Max tickets per purchase if stated, else null."),
  requiresApproval: z.boolean().describe("true if the user asked for manual approval, or if eligibility must be verified (e.g. student-only tickets)."),
  eligibility: z.string().nullable().describe("Who may buy it, in the event language, e.g. 'Geçerli öğrenci belgesi gereklidir.' null if unrestricted."),
  validDayIndexes: z.array(wholeNumber()).describe("0-based event days this ticket admits. Empty array = all days."),
});

export const draftFormField = z.object({
  key: z.string().describe("lowercase snake_case ASCII, unique. Must NOT be one of: " + RESERVED_FIELD_KEYS.join(", ") + "."),
  type: FormFieldType,
  label: z.string().describe("Turkish question label, e.g. 'Beslenme tercihiniz / kısıtlamanız var mı?'"),
  labelEn: z.string().nullable(),
  helpText: z.string().nullable(),
  required: z.boolean(),
  options: z.array(draftOption).nullable().describe("REQUIRED (2+ items) for SINGLE_SELECT / MULTI_SELECT. null for every other type."),
  maxLength: wholeNumber().nullable().describe("For text types only; else null."),
  visibleForTicketKeys: z.array(z.string()).describe("Ticket keys that see this field. Empty array = all tickets."),
  isSensitive: z.boolean().describe(
    "true if the answer can reveal health, religion, disability or ethnicity (KVKK special-category data). " +
      "Dietary restrictions and allergies are ALWAYS sensitive.",
  ),
  origin: LlmFieldOrigin.describe("EXPLICIT if the user asked for this information; INFERRED if you are proposing it."),
  rationale: z.string().describe("One short sentence: why this field exists. For INFERRED fields, why you suggest it."),
});

export const draftClarification = z.object({
  path: z.string().describe("Dot path of the missing value, e.g. 'event.startDate' or 'ticketTypes.corporate.priceAmount'."),
  question: z.string().describe("Question to ask the organizer, in Turkish."),
  blocking: z.boolean().describe("true if the event cannot be published without this answer."),
});

export const draftEventSchema = z.object({
    title: z.string().describe("Short title. If the user gave none, compose one from the description (e.g. 'İzmir Teknoloji Zirvesi') and list it in assumptions."),
    summary: z.string().nullable().describe("1–2 sentence public summary built ONLY from facts in the prompt."),
    format: EventFormat.describe("What kind of event it is (festival, congress, fair…). Independent of who organizes it."),
    deliveryMode: DeliveryMode.describe("IN_PERSON unless online/hybrid is mentioned."),
    primaryLanguage: z.enum(["tr", "en"]).describe("Language of attendee-facing text. 'tr' unless the user writes for an international audience."),
    bilingual: z.boolean().describe("true if attendee-facing text should also be provided in English (international events)."),
    city: z.string().nullable().describe("City name as written by the user, e.g. 'İzmir'. null if not stated. Do NOT output region or province codes."),
    venueName: z.string().nullable().describe("Only if the user named a venue. Never invent one."),
    startDate: z.string().nullable().describe("ISO date YYYY-MM-DD. ONLY if the user gave a date. Relative dates ('next March') may be resolved using today's date given in the system prompt. Otherwise null."),
    durationDays: wholeNumber().nullable().describe("Number of event days if stated, e.g. '3-day' → 3."),
    dailyStartTime: z.string().nullable().describe("HH:MM 24h if stated, else null."),
    dailyEndTime: z.string().nullable().describe("HH:MM 24h if stated, else null."),
    expectedAttendance: wholeNumber().nullable().describe("Expected attendee count if stated, e.g. 'for 500 people' → 500."),
    capacity: wholeNumber().nullable().describe("Hard capacity only if stated as a limit; else null."),
});

export const eventConfigDraftSchema = z.object({
  event: draftEventSchema,
  ticketTypes: z.array(draftTicketType).describe("Exactly the ticket types the user described. If none described, one FREE 'general' ticket and an assumption entry."),
  formFields: z.array(draftFormField).describe(
    "Custom registration questions. First name, last name, e-mail, phone and KVKK consent are added by the platform — do not include them.",
  ),
  clarifications: z.array(draftClarification).describe("Every value you left null that the organizer must decide."),
  assumptions: z.array(z.string()).describe("Every non-trivial choice you made that the user did not state, in Turkish."),
});

export type EventConfigDraft = z.infer<typeof eventConfigDraftSchema>;

/** Patch/refine mode: same shape — the model returns the full updated config. */
export const eventConfigPatchRequestSchema = z.object({
  prompt: z.string().min(3).max(4000),
  baseConfig: z.unknown().optional(),
  organizationId: z.uuid(),
  eventId: z.uuid().optional(),
});

// ---------------------------------------------------------------------------
// 2. STRICT DOMAIN SCHEMA
// ---------------------------------------------------------------------------

const machineKey = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "lowercase snake_case, 2–48 chars");
const isoDate = z.iso.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const optionSchema = z.object({
  value: machineKey,
  label: z.string().min(1).max(120),
  labelEn: z.string().min(1).max(120).nullable(),
});

export const ticketTypeSchema = z.object({
  key: machineKey,
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable(),
  pricing: TicketPricing,
  /** Integer kuruş/cents. null only while a blocking clarification is open. */
  priceAmountMinor: z.number().int().nonnegative().nullable(),
  currency: Currency,
  quantity: z.number().int().positive().nullable(),
  maxPerOrder: z.number().int().min(1).max(50),
  requiresApproval: z.boolean(),
  eligibility: z.string().max(300).nullable(),
  validDayIndexes: z.array(z.number().int().nonnegative()),
  sortOrder: z.number().int(),
});

export const formFieldSchema = z.object({
  key: machineKey,
  type: FormFieldType,
  label: z.string().min(1).max(200),
  labelEn: z.string().min(1).max(200).nullable(),
  helpText: z.string().max(500).nullable(),
  required: z.boolean(),
  options: z.array(optionSchema).min(2).max(50).nullable(),
  validation: z
    .object({ maxLength: z.number().int().positive().max(5000).nullable() })
    .nullable(),
  visibleForTicketKeys: z.array(machineKey),
  isSensitive: z.boolean(),
  origin: FieldOrigin,
  rationale: z.string().nullable(),
  sortOrder: z.number().int(),
});

export const clarificationSchema = z.object({
  path: z.string().min(1),
  question: z.string().min(1),
  blocking: z.boolean(),
});

export const eventProfileSchema = z.object({
      title: z.string().min(3).max(140),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
      summary: z.string().max(400).nullable(),
      format: EventFormat,
      deliveryMode: DeliveryMode,
      primaryLanguage: z.enum(["tr", "en"]),
      bilingual: z.boolean(),
      city: z.string().nullable(),
      provinceCode: z.number().int().min(1).max(81).nullable(),
      nuts2Code: z.custom<Nuts2Code>((v) => typeof v === "string" && /^TR[1-9A-C]\d$/.test(v)).nullable(),
      venueName: z.string().nullable(),
      timezone: z.literal("Europe/Istanbul"),
      startDate: isoDate.nullable(),
      endDate: isoDate.nullable(),
      durationDays: z.number().int().min(1).max(60).nullable(),
      dailyStartTime: hhmm.nullable(),
      dailyEndTime: hhmm.nullable(),
      expectedAttendance: z.number().int().positive().max(5_000_000).nullable(),
      capacity: z.number().int().positive().max(5_000_000).nullable(),
});
export type EventProfile = z.infer<typeof eventProfileSchema>;

export const eventConfigSchema = z
  .object({
    schemaVersion: z.literal(EVENT_CONFIG_SCHEMA_VERSION),
    event: eventProfileSchema,
    ticketTypes: z.array(ticketTypeSchema).min(1).max(20),
    formFields: z.array(formFieldSchema).max(60),
    clarifications: z.array(clarificationSchema),
    assumptions: z.array(z.string()),
  })
  .superRefine((cfg, ctx) => {
    const ticketKeys = new Set<string>();
    cfg.ticketTypes.forEach((t, i) => {
      if (ticketKeys.has(t.key)) ctx.addIssue({ code: "custom", path: ["ticketTypes", i, "key"], message: `duplicate ticket key '${t.key}'` });
      ticketKeys.add(t.key);
      if (t.pricing === "FREE" && t.priceAmountMinor !== 0)
        ctx.addIssue({ code: "custom", path: ["ticketTypes", i, "priceAmountMinor"], message: "FREE ticket must cost 0" });
      if (t.pricing === "PAID" && t.priceAmountMinor === 0)
        ctx.addIssue({ code: "custom", path: ["ticketTypes", i, "priceAmountMinor"], message: "PAID ticket cannot cost 0" });
      if (cfg.event.durationDays != null && t.validDayIndexes.some((d) => d >= cfg.event.durationDays!))
        ctx.addIssue({ code: "custom", path: ["ticketTypes", i, "validDayIndexes"], message: "day index outside event duration" });
    });

    const fieldKeys = new Set<string>();
    cfg.formFields.forEach((f, i) => {
      if (fieldKeys.has(f.key)) ctx.addIssue({ code: "custom", path: ["formFields", i, "key"], message: `duplicate field key '${f.key}'` });
      fieldKeys.add(f.key);
      const isSelect = SELECT_TYPES.has(f.type);
      if (isSelect && !f.options) ctx.addIssue({ code: "custom", path: ["formFields", i, "options"], message: "select field needs options" });
      if (!isSelect && f.options) ctx.addIssue({ code: "custom", path: ["formFields", i, "options"], message: "options only allowed on select fields" });
      for (const k of f.visibleForTicketKeys)
        if (!ticketKeys.has(k)) ctx.addIssue({ code: "custom", path: ["formFields", i, "visibleForTicketKeys"], message: `unknown ticket key '${k}'` });
    });

    if (cfg.formFields.some((f) => f.isSensitive) && !fieldKeys.has("kvkk_special_consent"))
      ctx.addIssue({ code: "custom", path: ["formFields"], message: "sensitive fields require kvkk_special_consent" });

    const { startDate, endDate } = cfg.event;
    if (startDate && endDate && endDate < startDate)
      ctx.addIssue({ code: "custom", path: ["event", "endDate"], message: "endDate before startDate" });
  });

export type EventConfig = z.infer<typeof eventConfigSchema>;
export type TicketTypeConfig = z.infer<typeof ticketTypeSchema>;
export type FormFieldConfig = z.infer<typeof formFieldSchema>;

// ---------------------------------------------------------------------------
// 3. NORMALIZER  (draft → strict). Pure, deterministic, unit-testable.
// ---------------------------------------------------------------------------

export type NormalizeResult =
  | { ok: true; config: EventConfig; repairs: string[] }
  | { ok: false; error: z.ZodError; repairs: string[]; partial: unknown };

export function toMachineKey(raw: string, fallback: string): string {
  const k = raw
    .replace(/İ/g, "I").replace(/ı/g, "i")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 48);
  return k.length >= 2 ? k : fallback;
}

export function toSlug(title: string): string {
  return toMachineKey(title, "etkinlik").replace(/_/g, "-").slice(0, 80);
}

export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isValidIsoDate = (s: string | null): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const SENSITIVE_HINT = /(diet|diyet|beslenme|allerg|alerji|saglik|health|medical|engel|disab|helal|halal|kosher|din|relig)/;

export type Clarify = (path: string, question: string, blocking: boolean) => void;

export const toPositiveInt = (n: number | null | undefined): number | null =>
  n != null && Number.isFinite(n) && n >= 1 ? Math.round(n) : null;

const hhmmOk = (t: string | null) => (t && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null);

/** Deterministic event-profile repair, shared by the Blueprint core stage and the registration stage. */
export function normalizeEventProfile(
  e: z.infer<typeof draftEventSchema>,
  today: string,
  clarify: Clarify,
  repairs: string[],
): EventProfile {
  const province = resolveProvince(e.city);
  if (e.city && !province) clarify("event.city", `"${e.city}" ili tanınamadı. Etkinlik hangi ilde?`, true);
  if (!e.city && e.deliveryMode !== "VIRTUAL") clarify("event.city", "Etkinlik hangi ilde yapılacak?", true);

  let startDate = isValidIsoDate(e.startDate) ? e.startDate : null;
  if (e.startDate && !startDate) repairs.push(`dropped invalid startDate '${e.startDate}'`);
  if (startDate && startDate < today) {
    repairs.push(`startDate ${startDate} is in the past; cleared`);
    clarify("event.startDate", "Belirtilen tarih geçmişte görünüyor. Etkinlik başlangıç tarihi nedir?", true);
    startDate = null;
  }
  if (!startDate) clarify("event.startDate", "Etkinlik hangi tarihte başlıyor?", true);

  const durationDays = toPositiveInt(e.durationDays) ?? (startDate ? 1 : null);
  if (!e.durationDays && startDate) repairs.push("durationDays defaulted to 1");
  const endDate = startDate && durationDays ? addDays(startDate, durationDays - 1) : null;

  return {
    title: e.title.trim(),
    slug: toSlug(e.title),
    summary: e.summary?.trim() || null,
    format: e.format,
    deliveryMode: e.deliveryMode,
    primaryLanguage: e.primaryLanguage,
    bilingual: e.bilingual,
    city: province?.name ?? e.city ?? null,
    provinceCode: province?.code ?? null,
    nuts2Code: province?.nuts2 ?? null,
    venueName: e.venueName?.trim() || null,
    timezone: "Europe/Istanbul",
    startDate,
    endDate,
    durationDays,
    dailyStartTime: hhmmOk(e.dailyStartTime),
    dailyEndTime: hhmmOk(e.dailyEndTime),
    expectedAttendance: toPositiveInt(e.expectedAttendance),
    capacity: toPositiveInt(e.capacity),
  };
}

export function normalizeEventConfig(draft: EventConfigDraft, opts: { today: string }): NormalizeResult {
  const repairs: string[] = [];
  const clarifications = [...draft.clarifications];
  const clarify = (path: string, question: string, blocking: boolean) => {
    if (!clarifications.some((c) => c.path === path)) {
      clarifications.push({ path, question, blocking });
      repairs.push(`added clarification for ${path}`);
    }
  };

  const e = draft.event;
  const event = normalizeEventProfile(e, opts.today, clarify, repairs);
  const { durationDays } = event;
  const posInt = toPositiveInt;

  // --- tickets -------------------------------------------------------------
  const usedTicketKeys = new Set<string>();
  const sourceTickets = draft.ticketTypes.length
    ? draft.ticketTypes
    : [{
        key: "general", name: "Genel Katılım", description: null, pricing: "FREE" as const,
        priceAmount: 0, currency: "TRY" as const, quantity: null, maxPerOrder: null,
        requiresApproval: false, eligibility: null, validDayIndexes: [],
      }];
  if (!draft.ticketTypes.length) repairs.push("no ticket types returned; added FREE 'general'");

  const ticketKeyMap = new Map<string, string>(); // model key → normalized key
  const ticketTypes: TicketTypeConfig[] = sourceTickets.map((t, i) => {
    let key = toMachineKey(t.key || t.name, `ticket_${i + 1}`);
    while (usedTicketKeys.has(key)) key = `${key}_${i + 1}`;
    usedTicketKeys.add(key);
    ticketKeyMap.set(t.key, key);

    let priceAmountMinor: number | null;
    if (t.pricing === "FREE") priceAmountMinor = 0;
    else if (t.priceAmount == null || t.priceAmount <= 0) {
      priceAmountMinor = t.pricing === "DONATION" ? 0 : null;
      if (t.pricing === "PAID") clarify(`ticketTypes.${key}.priceAmount`, `"${t.name}" bilet fiyatı nedir (KDV dahil)?`, true);
    } else priceAmountMinor = Math.round(t.priceAmount * 100);

    const validDayIndexes = [...new Set(t.validDayIndexes.map(Math.round))]
      .filter((d) => d >= 0 && (durationDays == null || d < durationDays))
      .sort((a, b) => a - b);

    return {
      key,
      name: t.name.trim().slice(0, 80),
      description: t.description?.trim() || null,
      pricing: t.pricing,
      priceAmountMinor,
      currency: t.currency,
      quantity: posInt(t.quantity),
      maxPerOrder: Math.min(posInt(t.maxPerOrder) ?? 1, 50),
      requiresApproval: t.requiresApproval,
      eligibility: t.eligibility?.trim() || null,
      validDayIndexes,
      sortOrder: i,
    };
  });

  // --- form fields ---------------------------------------------------------
  const reserved = new Set<string>(RESERVED_FIELD_KEYS);
  const usedFieldKeys = new Set<string>();
  const formFields: FormFieldConfig[] = [];
  draft.formFields.forEach((f, i) => {
    let key = toMachineKey(f.key || f.label, `field_${i + 1}`);
    if (reserved.has(key)) {
      repairs.push(`dropped reserved field '${key}'`);
      return;
    }
    while (usedFieldKeys.has(key)) key = `${key}_${i + 1}`;
    usedFieldKeys.add(key);

    const isSelect = SELECT_TYPES.has(f.type);
    let type = f.type;
    let options = isSelect && f.options?.length
      ? dedupeOptions(f.options.map((o, j) => ({
          value: toMachineKey(o.value || o.label, `opt_${j + 1}`),
          label: o.label.trim(),
          labelEn: o.labelEn?.trim() || null,
        })))
      : null;
    if (isSelect && (!options || options.length < 2)) {
      repairs.push(`field '${key}' had <2 options; downgraded to SHORT_TEXT`);
      type = "SHORT_TEXT";
      options = null;
    }

    const visibleForTicketKeys = f.visibleForTicketKeys
      .map((k) => ticketKeyMap.get(k) ?? toMachineKey(k, ""))
      .filter((k) => usedTicketKeys.has(k));

    const isSensitive = f.isSensitive || SENSITIVE_HINT.test(`${key} ${toMachineKey(f.label, "")}`);
    if (isSensitive && !f.isSensitive) repairs.push(`field '${key}' flagged KVKK-sensitive`);

    formFields.push({
      key,
      type,
      label: f.label.trim(),
      labelEn: f.labelEn?.trim() || null,
      helpText: f.helpText?.trim() || null,
      required: f.required,
      options,
      validation:
        (type === "SHORT_TEXT" || type === "LONG_TEXT") && posInt(f.maxLength)
          ? { maxLength: Math.min(posInt(f.maxLength)!, 5000) }
          : null,
      visibleForTicketKeys,
      isSensitive,
      origin: f.origin,
      rationale: f.rationale?.trim() || null,
      sortOrder: i,
    });
  });

  // KVKK: explicit consent for special-category data (6698 s. Kanun md. 6).
  if (formFields.some((f) => f.isSensitive)) {
    formFields.push({
      key: "kvkk_special_consent",
      type: "KVKK_CONSENT",
      label: "Beslenme/sağlık bilgilerimin yalnızca etkinlik hizmetinin sunulması amacıyla işlenmesine açık rıza veriyorum.",
      labelEn: draft.event.bilingual
        ? "I explicitly consent to my dietary/health information being processed solely to deliver event services."
        : null,
      helpText: null,
      required: true,
      options: null,
      validation: null,
      visibleForTicketKeys: [],
      isSensitive: false,
      origin: "SYSTEM",
      rationale: "KVKK md. 6 — özel nitelikli kişisel veri için açık rıza.",
      sortOrder: formFields.length,
    });
    repairs.push("injected kvkk_special_consent");
  }

  const candidate = {
    schemaVersion: EVENT_CONFIG_SCHEMA_VERSION,
    event,
    ticketTypes,
    formFields,
    clarifications,
    assumptions: draft.assumptions,
  };

  const parsed = eventConfigSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, config: parsed.data, repairs }
    : { ok: false, error: parsed.error, repairs, partial: candidate };
}

function dedupeOptions<T extends { value: string }>(opts: T[]): T[] {
  const seen = new Set<string>();
  return opts.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
}

/** True when the organizer can publish without answering anything else. */
export const isPublishable = (cfg: EventConfig) => !cfg.clarifications.some((c) => c.blocking);
