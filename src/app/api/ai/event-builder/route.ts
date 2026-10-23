/**
 * POST /api/ai/event-builder
 * Streams a partial EventConfigDraft to the client (`useObject` on the page), then — after
 * the response is sent — normalizes + validates the final object server-side and stores it on
 * the ai_generations row. The client never submits the config back for persistence; the
 * "Apply" Server Action reads the validated config from ai_generations by id.
 */
import { streamText, Output } from "ai";
import { after } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/db";
import { events } from "@/db/schema";
import { AuthError } from "@/server/auth/errors";
import { requireOrgPermission } from "@/server/auth/org-access";
import { AI_TASKS, modelFor, structuredProviderOptions } from "@/server/ai/models";
import { classifyAiError } from "@/server/ai/failures";
import { startGeneration, finishGeneration } from "@/server/logistics/ai-generations-drizzle";
import {
  EVENT_CONFIG_SCHEMA_VERSION,
  eventConfigDraftSchema,
  eventConfigPatchRequestSchema,
  normalizeEventConfig,
} from "@/lib/ai/schemas/event-config";
import { buildEventBuilderSystemPrompt } from "@/lib/ai/prompts/event-builder";
import { todayIstanbul } from "@/lib/time/istanbul";

export const runtime = "nodejs";
export const maxDuration = 60;


export async function POST(req: Request): Promise<Response> {
  const body = eventConfigPatchRequestSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.treeifyError(body.error) }, { status: 400 });
  const { prompt, baseConfig, organizationId, eventId } = body.data;

  let ctx;
  try {
    ctx = await requireOrgPermission(organizationId, "blueprint.generate");
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }

  // The event must belong to the caller's organization: 404 otherwise, nothing read or written.
  if (eventId) {
    const [own] = await adminDb
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, ctx.organizationId)))
      .limit(1);
    if (!own) return Response.json({ error: "Event not found" }, { status: 404 });
  }

  const task = AI_TASKS.eventBuilder;
  const today = todayIstanbul();
  const startedAt = Date.now();

  const generationId = await startGeneration(ctx, {
    eventId,
    kind: baseConfig ? "event_config_patch" : "event_config",
    prompt,
    baseConfig,
    schemaVersion: EVENT_CONFIG_SCHEMA_VERSION,
    provider: task.provider,
    model: task.modelId,
    temperature: task.temperature,
  });

  // the real provider error of a failed stream (result.output only says "no output generated")
  let streamError: unknown = null;
  const result = streamText({
    onError: ({ error }) => { streamError ??= error; },
    model: modelFor("eventBuilder"),
    providerOptions: structuredProviderOptions(),
    temperature: task.temperature,
    maxOutputTokens: task.maxOutputTokens,
    system: buildEventBuilderSystemPrompt({ today, orgName: ctx.organizationName, baseConfig }),
    prompt,
    output: Output.object({
      schema: eventConfigDraftSchema,
      name: "event_config",
      description: "Structured configuration for one event: details, ticket types, registration form fields.",
    }),
  });

  after(async () => {
    try {
      const draft = await result.output;
      const usage = await result.totalUsage;
      const normalized = normalizeEventConfig(draft, { today });
      await finishGeneration(
        ctx,
        generationId,
        normalized.ok
          ? {
              status: "SUCCEEDED",
              output: { draft, config: normalized.config, repairs: normalized.repairs },
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              latencyMs: Date.now() - startedAt,
            }
          : {
              status: "FAILED_VALIDATION",
              output: { draft, partial: normalized.partial, repairs: normalized.repairs },
              errors: z.treeifyError(normalized.error),
              latencyMs: Date.now() - startedAt,
            },
      );
    } catch (err) {
      await finishGeneration(ctx, generationId, {
        status: "FAILED_PROVIDER",
        errors: (() => { const f = classifyAiError(streamError ?? err); return { message: f.message, kind: f.kind, status: f.status ?? null }; })(),
        latencyMs: Date.now() - startedAt,
      });
    }
  });

  return result.toTextStreamResponse({ headers: { "x-generation-id": generationId } });
}
