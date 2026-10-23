/**
 * Read side of the AI flow for the organizer UI, under RLS as the caller (ai_generations and proposals
 * are readable by every member of the organization, never writable from the browser):
 *  - a generation's status, so the UI can poll after the stream ends (finalisation runs in after());
 *  - proposal cards to approve/reject (POST /api/proposals/:id), with their operations.
 */
import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { aiGenerations, proposals } from "@/db/schema";
import type { UserDbRunner } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";
import { AI_FAILURE_TEXT, classifyAiError, scrubSecrets, type AiFailureKind } from "@/server/ai/failures";
import { toApiProposalStatus, PROPOSAL_API_STATUS, type ProposalDbStatus } from "@/server/planning/proposal-error";

export async function getGeneration(runAsUser: UserDbRunner, organizationId: string, generationId: string) {
  const [g] = await runAsUser((tx) =>
    tx
      .select({
        id: aiGenerations.id, kind: aiGenerations.kind, status: aiGenerations.status, eventId: aiGenerations.eventId,
        output: aiGenerations.output, validationErrors: aiGenerations.validationErrors, latencyMs: aiGenerations.latencyMs,
        createdAt: aiGenerations.createdAt,
      })
      .from(aiGenerations)
      .where(and(eq(aiGenerations.id, generationId), eq(aiGenerations.organizationId, organizationId)))
      .limit(1),
  );
  if (!g) throw new ApiError(404, "Generation not found");
  const produced = await runAsUser((tx) =>
    tx.select({ id: proposals.id, kind: proposals.kind, status: proposals.status }).from(proposals)
      .where(and(eq(proposals.generationId, generationId), eq(proposals.organizationId, organizationId))),
  );
  return {
    ...g,
    /** STREAMING until the server has validated the output; then SUCCEEDED or FAILED_*. */
    done: g.status !== "STREAMING",
    /** The provider refused for quota / rate limit (e.g. the Gemini free tier's daily limit). */
    quotaExceeded: g.status === "FAILED_PROVIDER" && /\b429\b|quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(JSON.stringify(g.validationErrors ?? "")),
    /** For a provider failure: what went wrong, in the organizer's language, with the provider's (scrubbed) message. */
    failure: g.status === "FAILED_PROVIDER" ? providerFailure(g.validationErrors) : null,
    proposals: produced.map((p) => ({ ...p, status: toApiProposalStatus(p.status) })),
  };
}

/** API status → stored status (APPLIED is stored as APPROVED). */
const API_TO_DB = Object.fromEntries(Object.entries(PROPOSAL_API_STATUS).map(([db, api]) => [api, db])) as Record<string, ProposalDbStatus>;
export const PROPOSAL_API_STATUSES = Object.keys(API_TO_DB) as [string, ...string[]];

export async function listProposals(
  runAsUser: UserDbRunner,
  organizationId: string,
  filter: { eventId?: string | null; statuses?: string[] },
) {
  const rows = await runAsUser((tx) =>
    tx
      .select({
        id: proposals.id, kind: proposals.kind, title: proposals.title, rationale: proposals.rationale, status: proposals.status,
        eventId: proposals.eventId, generationId: proposals.generationId, payload: proposals.payload,
        appliedOps: proposals.appliedOps, appliedSummary: proposals.appliedSummary, errorMessage: proposals.errorMessage,
        expiresAt: proposals.expiresAt, decidedAt: proposals.decidedAt, createdAt: proposals.createdAt,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.organizationId, organizationId),
          filter.eventId === undefined ? undefined : filter.eventId === null ? isNull(proposals.eventId) : eq(proposals.eventId, filter.eventId),
          filter.statuses?.length ? inArray(proposals.status, filter.statuses.map((s) => API_TO_DB[s]!)) : undefined,
        ),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(200),
  );
  return rows.map(({ payload, status, ...p }) => ({
    ...p,
    status: toApiProposalStatus(status),
    operations: (payload as { operations?: unknown[] }).operations ?? [],
  }));
}

/** Stored errors → { kind, text, detail }. Older rows only have a message: it is classified again. */
function providerFailure(errors: unknown): { kind: AiFailureKind; text: string; detail: string } {
  const e = (errors ?? {}) as { message?: unknown; kind?: unknown };
  const message = scrubSecrets(typeof e.message === "string" ? e.message : JSON.stringify(errors ?? "")).slice(0, 400);
  const kind = typeof e.kind === "string" && e.kind in AI_FAILURE_TEXT ? (e.kind as AiFailureKind) : classifyAiError(new Error(message)).kind;
  return { kind, text: AI_FAILURE_TEXT[kind], detail: message };
}
