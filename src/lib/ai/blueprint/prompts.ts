/**
 * System prompts for the Blueprint stages. One shared rule block + a stage-specific brief.
 * Section prompts receive the *approved* core as context, so every stage plans the same event.
 */
import type { BlueprintCore, BlueprintCoreDraft } from "@/lib/ai/blueprint/core";
import { MODULES, vocabularyFor, type ModuleDef } from "@/lib/modules/registry";
import type { MetricSeed } from "@/lib/metrics/library";
import type { OrganizerTypeValue, SurveyAudienceValue } from "@/lib/domain/enums";

export const BLUEPRINT_PROMPT_VERSION = "blueprint/2026-10-16";

const SHARED_RULES = [
  "Hard rules:",
  "- Extract, do not invent. Dates, prices, amounts, venues, organisation names and quantities appear only if the organizer stated them or they follow arithmetically. Otherwise null + a clarification.",
  "- Attendee- and organizer-facing text is Turkish. Machine keys are lowercase snake_case ASCII.",
  "- Every non-obvious choice goes into `assumptions` (Turkish).",
  "- Be specific to THIS event's type, scale, city and season. Generic filler is worse than fewer items.",
].join("\n");

const header = (today: string, orgName: string) =>
  `You are the planning engine of Live Event OS, an event-management platform for Turkey. Today is ${today} (Europe/Istanbul). Organization: "${orgName}".`;

// ---------------------------------------------------------------------------
// Stage 1 — core
// ---------------------------------------------------------------------------

const CORE_EXAMPLE_REQUEST =
  "Adana'da 2027 Nisan'da dört gün sürecek, konserlerin, yerel ürün stantlarının ve sponsorların yer aldığı bir şehir festivali düzenliyoruz. Günlük 15 bin ziyaretçi bekliyoruz. Amacımız şehre turist çekmek ve yerel üreticileri desteklemek.";

const CORE_EXAMPLE: BlueprintCoreDraft = {
  event: {
    title: "Adana Şehir Festivali 2027", summary: "Nisan 2027'de Adana'da konserler, yerel ürün stantları ve sponsor alanlarıyla dört günlük şehir festivali.",
    format: "FESTIVAL", deliveryMode: "IN_PERSON", primaryLanguage: "tr", bilingual: false, city: "Adana", venueName: null,
    startDate: null, durationDays: 4, dailyStartTime: null, dailyEndTime: null, expectedAttendance: 60000, capacity: null,
  },
  objectives: [
    { text: "Şehre turist çekmek", origin: "EXPLICIT" },
    { text: "Yerel üreticileri desteklemek", origin: "EXPLICIT" },
  ],
  audience: null,
  clientOrganizerType: null,
  clientName: null,
  budgetTotalTry: null,
  proposedModules: [
    { key: "booths", reason: "Yerel ürün stantları planlanıyor." },
    { key: "sponsorship", reason: "Organizatör sponsorlardan söz etti." },
    { key: "economic_impact", reason: "Turist çekme hedefi ziyaretçi harcamasının ölçülmesini gerektirir." },
    { key: "community_impact", reason: "Şehir festivali yerel halkı doğrudan etkiler." },
  ],
  stakeholders: [
    { kind: "SPONSOR", name: "Sponsorlar (aranıyor)", role: "Finansman ve görünürlük", origin: "EXPLICIT" },
    { kind: "EXHIBITOR", name: "Yerel üreticiler", role: "Stant açan katılımcılar", origin: "EXPLICIT" },
    { kind: "ARTIST", name: "Konser sanatçıları", role: "Sahne programı", origin: "EXPLICIT" },
    { kind: "PUBLIC_AUTHORITY", name: "Valilik ve emniyet birimleri", role: "İzinler ve güvenlik koordinasyonu", origin: "INFERRED" },
    { kind: "LOCAL_BUSINESS", name: "Festival alanı çevresindeki esnaf", role: "Ekonomik etkiden doğrudan etkilenen grup", origin: "INFERRED" },
  ],
  clarifications: [
    { path: "event.startDate", question: "Festival Nisan 2027'de hangi tarihte başlıyor?", blocking: true },
    { path: "event.venueName", question: "Festival hangi alanda yapılacak?", blocking: false },
  ],
  assumptions: [
    "Günlük 15.000 ziyaretçi × 4 gün = 60.000 toplam ziyaret olarak hesaplandı; tekil kişi sayısı daha düşük olabilir.",
    "Kamu kurumları ve çevre esnafı, şehir festivallerinde olağan paydaşlar olduğu için öneri olarak eklendi.",
  ],
};

export function buildCoreSystemPrompt(ctx: { today: string; orgName: string; organizationType: OrganizerTypeValue }): string {
  const modules = (MODULES as readonly ModuleDef[])
    .filter((m) => !m.core)
    .map((m) => {
      const hints = [...m.recommendedFor.formats, ...m.recommendedFor.organizerTypes];
      const blocked = m.incompatibleWith.deliveryModes.length ? ` Not for ${m.incompatibleWith.deliveryModes.join("/")} events.` : "";
      return `- ${m.key}: ${m.label} — ${m.description}${hints.length ? ` Typical for: ${hints.join(", ")}.` : ""}${blocked}`;
    })
    .join("\n");
  return [
    header(ctx.today, ctx.orgName),
    `The organization is of type ${ctx.organizationType}. Do not infer a different organizer type; set clientOrganizerType only when the organizer says they work for a client.`,
    "",
    "Stage 1 of the Event Blueprint: turn the organizer's description into the event profile. Later stages (tasks, KPIs, surveys, budget, registration) build on what you return, so be precise.",
    "",
    SHARED_RULES,
    "- `format` is what kind of event it is. Who organizes it is a separate field (`onBehalfOf`) and never changes the format.",
    "- `expectedAttendance` is total visits over the whole event if the organizer gave a daily figure (show the arithmetic in assumptions).",
    "- Propose optional modules when the description gives a reason, for any format (a conference may have a stage; a festival may have talks). 'Typical for' is a hint, not a limit. Available modules:",
    modules,
    "- Stakeholders: never invent organisation names; use role placeholders such as 'Ana sponsor (aranıyor)'.",
    "",
    "<example>",
    `<request>${CORE_EXAMPLE_REQUEST}</request>`,
    `<response>${JSON.stringify(CORE_EXAMPLE)}</response>`,
    "</example>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Section stages
// ---------------------------------------------------------------------------

function coreContext(core: BlueprintCore): string {
  const vocab = vocabularyFor(core.modules.map((m) => m.key));
  return JSON.stringify({
    event: core.event,
    objectives: core.objectives.map((o, i) => ({ index: i, ...o })),
    audience: core.audience,
    organizerType: core.organizer.effectiveType,
    budgetTotalTry: core.budgetTotalMinor != null ? core.budgetTotalMinor / 100 : null,
    modules: core.modules.map((m) => m.key),
    workstreams: vocab.workstreamLabels,
    stakeholders: core.stakeholders.map(({ kind, name, role }) => ({ kind, name, role })),
  });
}

export function buildSectionSystemPrompt(
  section: "tasks" | "kpis" | "surveys" | "budget_risks" | "registration",
  ctx: { today: string; orgName: string; core: BlueprintCore; candidates?: MetricSeed[]; audiences?: SurveyAudienceValue[] },
): string {
  const brief: Record<typeof section, string[]> = {
    tasks: [
      "Produce the task plan for this event: what has to be done, by which role, and when relative to day 0.",
      "- Cover PLAN → PREPARE → MANAGE → RUN → ANALYZE. Include event-day OPERATIONS tasks for on-site work.",
      "- Lead times must be realistic for Turkey and this scale (e.g. permits for large public events typically need weeks to months; venue and headline artists are booked early).",
      "- Do NOT create data-collection or survey tasks: the platform derives them from the KPI plan.",
      "- Use dependsOnKeys only for real hard dependencies.",
    ],
    kpis: [
      "Select KPIs for this event from the candidate metrics below. Each EXPLICIT objective needs at least one KPI.",
      "- Prefer few, decision-relevant KPIs over many. Avoid redundant metrics.",
      "- A target is allowed only when targetBasis can point at the organizer's words or arithmetic on them.",
      "<candidate_metrics>",
      JSON.stringify((ctx.candidates ?? []).map(({ key, name, description, unit, dataSources }) => ({ key, name, description, unit, dataSources }))),
      "</candidate_metrics>",
    ],
    surveys: [
      `Write survey drafts for these audiences: ${(ctx.audiences ?? []).join(", ")}.`,
      "- The platform injects the standard KPI questions (satisfaction, NPS, residence, spending, etc.). Add only event-specific questions the organizer will act on.",
      "- Short and neutral. No leading, double-barrelled or identity-revealing questions.",
    ],
    budget_risks: [
      "Produce the budget skeleton (expense and income lines) and the risk register.",
      "- Budget lines are identified, not priced: plannedAmountTry stays null unless the organizer stated that exact amount. Never split a total.",
      "- Risks: specific to type, scale, season and location; concrete mitigation and an owner role.",
    ],
    registration: [
      "Produce registration: ticket types and custom registration form fields.",
      "- Name, surname, e-mail, phone and consent checkboxes are added by the platform; do not output them.",
      "- If the organizer did not describe tickets: one FREE general ticket for registration-based events; for open public events, a free registration only if useful for counting or communication, with an assumption saying so.",
      "- Dietary, health or accessibility questions are KVKK special-category data (isSensitive = true).",
    ],
  };
  return [
    header(ctx.today, ctx.orgName),
    "",
    "The organizer has approved the event profile below. Plan within it; do not change its facts.",
    "<event_profile>",
    coreContext(ctx.core),
    "</event_profile>",
    "",
    SHARED_RULES,
    ...brief[section],
  ].join("\n");
}
