/**
 * Drizzle data access for `ai_generations`.
 *
 * Security model (0004):
 *  - Clients can only READ ai_generations (RLS tenant read policy); INSERT/UPDATE/DELETE are revoked
 *    from `authenticated`/`anon`. Every write here therefore goes through `adminDb` (RLS bypassed),
 *    which is only allowed AFTER the caller has been authorized (requireOrgPermission).
 *  - The organization and the requesting user come from that verified `OrgAccess`, never from
 *    request input. Every statement is scoped by `organization_id`, so a generation id belonging to
 *    another tenant is treated as "not found" (no cross-tenant update/read even though RLS is off).
 *  - Composite FKs (event_id, organization_id) and (requested_by, organization_id) make the database
 *    itself reject an event or user from another organization.
 */
import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { adminDb } from "@/db";
import type { AppDatabase, AppTransaction } from "@/db/rls";
import { aiGenerations, aiGenerationStatus } from "@/db/schema";
import type { OrgAccess } from "@/server/auth/org-access";

export type AiGenerationStatus = (typeof aiGenerationStatus.enumValues)[number];

/** The verified caller (the result of requireOrgPermission / requireOrgRole). */
export type GenerationScope = Pick<OrgAccess, "organizationId" | "userId">;

/** Either adminDb or a transaction opened on it (e.g. the applyProposal transaction). */
export type GenerationDb = AppDatabase | AppTransaction;

export interface GenerationRecord {
  eventId?: string;
  /** "event_config" | "event_config_patch" | "blueprint.core" | "blueprint.<section>" | "copilot" */
  kind: string;
  prompt: string;
  baseConfig?: unknown;
  schemaVersion: string;
  provider: string;
  model: string;
  temperature: number;
}

export type GenerationResult =
  | { status: "SUCCEEDED"; output: unknown; inputTokens?: number; outputTokens?: number; latencyMs: number }
  | { status: "FAILED_VALIDATION" | "FAILED_PROVIDER"; output?: unknown; errors: unknown; latencyMs: number };

/** No generation with this id exists in the caller's organization (also for another tenant's id). */
export class GenerationNotFoundError extends Error {
  constructor(id: string) {
    super(`AI generation ${id} not found`);
    this.name = "GenerationNotFoundError";
  }
}

/** Records the start of a model call (status STREAMING). Returns the generation id. */
export async function startGeneration(scope: GenerationScope, rec: GenerationRecord, db: GenerationDb = adminDb): Promise<string> {
  const [row] = await db
    .insert(aiGenerations)
    .values({
      organizationId: scope.organizationId,
      requestedBy: scope.userId,
      eventId: rec.eventId ?? null,
      kind: rec.kind,
      prompt: rec.prompt,
      baseConfig: rec.baseConfig === undefined ? null : rec.baseConfig,
      schemaVersion: rec.schemaVersion,
      provider: rec.provider,
      model: rec.model,
      temperature: String(rec.temperature), // numeric(3,2)
      status: "STREAMING",
    })
    .returning({ id: aiGenerations.id });
  return row!.id;
}

/** Records the outcome of a model call. Throws GenerationNotFoundError if the id is not in the caller's organization. */
export async function finishGeneration(scope: GenerationScope, id: string, result: GenerationResult, db: GenerationDb = adminDb): Promise<void> {
  const rows = await db
    .update(aiGenerations)
    .set({
      status: result.status,
      output: result.output ?? null,
      validationErrors: "errors" in result ? (result.errors ?? null) : null,
      // undefined = leave unchanged
      inputTokens: "inputTokens" in result ? result.inputTokens : undefined,
      outputTokens: "outputTokens" in result ? result.outputTokens : undefined,
      latencyMs: result.latencyMs,
    })
    .where(and(eq(aiGenerations.id, id), eq(aiGenerations.organizationId, scope.organizationId)))
    .returning({ id: aiGenerations.id });
  if (rows.length === 0) throw new GenerationNotFoundError(id);
}

/**
 * Marks the generation behind an applied proposal as APPLIED and links it to the event.
 * Meant to run inside the apply transaction (pass `tx`) so it rolls back with the rest.
 */
export async function markGenerationApplied(db: GenerationDb, organizationId: string, id: string, eventId: string): Promise<void> {
  const rows = await db
    .update(aiGenerations)
    .set({ status: "APPLIED", eventId })
    .where(and(eq(aiGenerations.id, id), eq(aiGenerations.organizationId, organizationId)))
    .returning({ id: aiGenerations.id });
  if (rows.length === 0) throw new GenerationNotFoundError(id);
}

/** Output of the most recent APPLIED `blueprint.core` generation of an event in this organization, or null. */
export async function findAppliedCoreOutput(organizationId: string, eventId: string, db: GenerationDb = adminDb): Promise<unknown> {
  const [row] = await db
    .select({ output: aiGenerations.output })
    .from(aiGenerations)
    .where(
      and(
        eq(aiGenerations.organizationId, organizationId),
        eq(aiGenerations.eventId, eventId),
        eq(aiGenerations.kind, "blueprint.core"),
        eq(aiGenerations.status, "APPLIED"),
      ),
    )
    .orderBy(desc(aiGenerations.createdAt))
    .limit(1);
  return row?.output ?? null;
}
