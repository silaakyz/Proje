/**
 * Blueprint stage 1 — the event profile.
 *
 * Fast, streamed, confirmed by the organizer before anything else is generated. Everything later
 * stages need (event type, enabled modules, objectives, dates, scale) is fixed here, so the section
 * stages can run in parallel against a stable context.
 */
import { z } from "zod";
import {
  draftClarification,
  draftEventSchema,
  eventProfileSchema,
  normalizeEventProfile,
  toPositiveInt,
  type Clarify,
} from "@/lib/ai/schemas/event-config";
import { ORGANIZER_TYPES, STAKEHOLDER_KINDS, type OrganizerTypeValue } from "@/lib/domain/enums";
import { MODULE_KEYS, resolveModules, type ModuleKey, type ModuleRequest } from "@/lib/modules/registry";

export const BLUEPRINT_SCHEMA_VERSION = "blueprint/v1" as const;

// ---------------------------------------------------------------------------
// LLM draft
// ---------------------------------------------------------------------------

export const blueprintCoreDraftSchema = z.object({
  event: draftEventSchema,
  objectives: z
    .array(
      z.object({
        text: z.string().describe("One goal, in Turkish, in the organizer's terms. e.g. 'Şehre turist çekmek'."),
        origin: z.enum(["EXPLICIT", "INFERRED"]).describe("EXPLICIT if the organizer said it; INFERRED if you propose it."),
      }),
    )
    .describe("What the event must achieve. Explicit goals first. At most 2 INFERRED goals, only when obvious from the description."),
  audience: z.string().nullable().describe("Who attends, as described by the organizer. null if not described."),
  clientOrganizerType: z
    .enum(ORGANIZER_TYPES)
    .nullable()
    .describe("ONLY if the organizer says they run this event on behalf of a client (e.g. an agency organising a municipality's festival): the client's type. Otherwise null."),
  clientName: z.string().nullable().describe("The client's name if stated, else null."),
  budgetTotalTry: z.number().nullable().describe("Total budget in TRY ONLY if the organizer stated it. Never estimate."),
  proposedModules: z
    .array(
      z.object({
        key: z.enum(MODULE_KEYS),
        reason: z.string().describe("One sentence tied to something the organizer said."),
      }),
    )
    .describe("Optional modules beyond the defaults. Any module may be proposed for any format when the description gives a reason (e.g. a stage at a conference, talks at a festival)."),
  stakeholders: z
    .array(
      z.object({
        kind: z.enum(STAKEHOLDER_KINDS),
        name: z.string().describe("Named organisation if the organizer named one, otherwise a role such as 'Ana sponsor (aranıyor)'."),
        role: z.string().nullable().describe("What they contribute or expect."),
        origin: z.enum(["EXPLICIT", "INFERRED"]),
      }),
    )
    .describe("Stakeholder groups. Never invent organisation names; use role placeholders."),
  clarifications: z.array(draftClarification),
  assumptions: z.array(z.string()),
});
export type BlueprintCoreDraft = z.infer<typeof blueprintCoreDraftSchema>;

// ---------------------------------------------------------------------------
// Strict
// ---------------------------------------------------------------------------

export const objectiveSchema = z.object({ text: z.string().min(3).max(200), origin: z.enum(["EXPLICIT", "INFERRED"]) });

export const blueprintCoreSchema = z.object({
  schemaVersion: z.literal(BLUEPRINT_SCHEMA_VERSION),
  event: eventProfileSchema,
  objectives: z.array(objectiveSchema).max(8),
  audience: z.string().max(500).nullable(),
  organizer: z.object({
    /** From the organization record — never from the LLM. */
    organizationType: z.enum(ORGANIZER_TYPES),
    clientOrganizerType: z.enum(ORGANIZER_TYPES).nullable(),
    clientName: z.string().max(200).nullable(),
    /** client ?? organization — used for recommendations and report templates. */
    effectiveType: z.enum(ORGANIZER_TYPES),
  }),
  budgetTotalMinor: z.number().int().nonnegative().nullable(),
  modules: z.array(
    z.object({
      key: z.enum(MODULE_KEYS),
      source: z.enum(["DEFAULT", "AI_PROPOSED", "ORGANIZER", "DEPENDENCY"]),
      reason: z.string().nullable(),
    }),
  ),
  stakeholders: z
    .array(
      z.object({
        key: z.string(),
        kind: z.enum(STAKEHOLDER_KINDS),
        name: z.string().min(1).max(160),
        role: z.string().max(300).nullable(),
        origin: z.enum(["EXPLICIT", "INFERRED"]),
      }),
    )
    .max(40),
  clarifications: z.array(z.object({ path: z.string(), question: z.string(), blocking: z.boolean() })),
  assumptions: z.array(z.string()),
});
export type BlueprintCore = z.infer<typeof blueprintCoreSchema>;

export type CoreResult =
  | { ok: true; core: BlueprintCore; repairs: string[] }
  | { ok: false; error: z.ZodError; repairs: string[]; partial: unknown };

export function normalizeBlueprintCore(
  draft: BlueprintCoreDraft,
  opts: { today: string; organizationType: OrganizerTypeValue; organizerModules?: readonly ModuleKey[] },
): CoreResult {
  const repairs: string[] = [];
  const clarifications = [...draft.clarifications];
  const clarify: Clarify = (path, question, blocking) => {
    if (!clarifications.some((c) => c.path === path)) {
      clarifications.push({ path, question, blocking });
      repairs.push(`added clarification for ${path}`);
    }
  };

  const event = normalizeEventProfile(draft.event, opts.today, clarify, repairs);

  // Organizer: the organization's own type comes from the DB; a client is taken only if stated.
  const organizer = {
    organizationType: opts.organizationType,
    clientOrganizerType: draft.clientOrganizerType,
    clientName: draft.clientOrganizerType ? draft.clientName?.trim() || null : null,
    effectiveType: draft.clientOrganizerType ?? opts.organizationType,
  };

  // Modules: compatibility rules, not a per-format allow-list.
  const requests: ModuleRequest[] = [
    ...draft.proposedModules.map((p) => ({ key: p.key, source: "AI_PROPOSED" as const, reason: p.reason.trim() || null })),
    ...(opts.organizerModules ?? []).map((key) => ({ key, source: "ORGANIZER" as const, reason: null })),
  ];
  const resolved = resolveModules(requests, {
    format: event.format,
    deliveryMode: event.deliveryMode,
    organizerType: organizer.effectiveType,
  });
  repairs.push(...resolved.repairs);
  const modules: BlueprintCore["modules"] = resolved.modules;

  // Objectives: explicit first, cap inferred at 2, dedupe.
  const seen = new Set<string>();
  const explicit = draft.objectives.filter((o) => o.origin === "EXPLICIT");
  const inferred = draft.objectives.filter((o) => o.origin === "INFERRED").slice(0, 2);
  if (draft.objectives.filter((o) => o.origin === "INFERRED").length > 2) repairs.push("capped inferred objectives at 2");
  const objectives = [...explicit, ...inferred]
    .map((o) => ({ text: o.text.trim(), origin: o.origin }))
    .filter((o) => o.text.length >= 3 && !seen.has(o.text.toLocaleLowerCase("tr")) && seen.add(o.text.toLocaleLowerCase("tr")))
    .slice(0, 8);
  if (!explicit.length) clarify("objectives", "Bu etkinlikle ulaşmak istediğiniz en önemli 1–3 hedef nedir?", false);

  const budget = toPositiveInt(draft.budgetTotalTry);
  const stakeholderKeys = new Set<string>();
  const stakeholders = draft.stakeholders.slice(0, 40).map((sh, i) => {
    let key = `${sh.kind.toLowerCase()}_${i + 1}`;
    while (stakeholderKeys.has(key)) key = `${key}_x`;
    stakeholderKeys.add(key);
    return { key, kind: sh.kind, name: sh.name.trim().slice(0, 160), role: sh.role?.trim() || null, origin: sh.origin };
  });

  const candidate = {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    event,
    objectives,
    audience: draft.audience?.trim() || null,
    organizer,
    budgetTotalMinor: budget != null ? budget * 100 : null,
    modules,
    stakeholders,
    clarifications,
    assumptions: draft.assumptions,
  };
  const parsed = blueprintCoreSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, core: parsed.data, repairs }
    : { ok: false, error: parsed.error, repairs, partial: candidate };
}

export const enabledModuleKeys = (core: BlueprintCore): ModuleKey[] => core.modules.map((m) => m.key);
