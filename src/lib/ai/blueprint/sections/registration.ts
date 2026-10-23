/**
 * Blueprint section — registration: ticket types and form fields.
 * Reuses the Prompt-to-Event contract; the event profile comes from the approved core.
 */
import { z } from "zod";
import {
  draftClarification,
  draftFormField,
  draftTicketType,
  normalizeEventConfig,
  type EventConfig,
} from "@/lib/ai/schemas/event-config";
import type { BlueprintCoreDraft } from "@/lib/ai/blueprint/core";

export const registrationDraftSchema = z.object({
  ticketTypes: z.array(draftTicketType),
  formFields: z.array(draftFormField),
  clarifications: z.array(draftClarification),
  assumptions: z.array(z.string()),
});
export type RegistrationDraft = z.infer<typeof registrationDraftSchema>;

export type RegistrationResult =
  | {
      ok: true;
      ticketTypes: EventConfig["ticketTypes"];
      formFields: EventConfig["formFields"];
      clarifications: EventConfig["clarifications"];
      repairs: string[];
      warnings: string[];
    }
  | { ok: false; error: z.ZodError; repairs: string[] };

export function normalizeRegistration(
  draft: RegistrationDraft,
  coreDraftEvent: BlueprintCoreDraft["event"],
  opts: { today: string; paidTicketsEnabled: boolean },
): RegistrationResult {
  const r = normalizeEventConfig({ event: coreDraftEvent, ...draft }, { today: opts.today });
  if (!r.ok) return { ok: false, error: r.error, repairs: r.repairs };
  const warnings: string[] = [];
  if (!opts.paidTicketsEnabled && r.config.ticketTypes.some((t) => t.pricing === "PAID"))
    warnings.push("Ücretli bilet satışı henüz açık değil: ücretli bilet türleri taslak olarak kaydedilir, satışa açılamaz.");
  // Event-level clarifications (date, city) belong to the core stage; keep only registration ones here.
  const clarifications = r.config.clarifications.filter((c) => !c.path.startsWith("event."));
  return { ok: true, ticketTypes: r.config.ticketTypes, formFields: r.config.formFields, clarifications, repairs: r.repairs, warnings };
}
