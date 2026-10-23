/**
 * POST /api/ai/blueprint — Stage 1 (event profile).
 * Streams the draft to the AI Workspace (`useObject`). After the response, the final object is
 * normalized and stored as a `blueprint.core` proposal; the organizer applies it from the card.
 */
import { generateText, streamText, Output } from "ai";
import { after } from "next/server";
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-access";
import { AI_TASKS, assertAiConfigured, modelFor, structuredProviderOptions } from "@/server/ai/models";
import { finalizeCoreGeneration } from "@/server/ai/blueprint-drizzle";
import { startGeneration } from "@/server/logistics/ai-generations-drizzle";
import { toErrorResponse } from "@/server/http";
import { BLUEPRINT_SCHEMA_VERSION, blueprintCoreDraftSchema } from "@/lib/ai/blueprint/core";
import { buildCoreSystemPrompt } from "@/lib/ai/blueprint/prompts";
import { MODULE_KEYS } from "@/lib/modules/registry";
import { todayIstanbul } from "@/lib/time/istanbul";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  organizationId: z.uuid(),
  prompt: z.string().min(10).max(6000),
  /** Modules the organizer ticked in the UI before generating, if any. */
  modules: z.array(z.enum(MODULE_KEYS)).max(20).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const body = bodySchema.parse(await req.json().catch(() => null));
    const org = await requireOrgPermission(body.organizationId, "blueprint.generate");
    assertAiConfigured();
    const task = AI_TASKS.eventBuilder;
    const today = todayIstanbul();
    const startedAt = Date.now();

    const generationId = await startGeneration(org, {
      kind: "blueprint.core", prompt: body.prompt,
      schemaVersion: BLUEPRINT_SCHEMA_VERSION, provider: task.provider, model: task.modelId, temperature: task.temperature,
    });

    const request = {
      temperature: task.temperature,
      maxOutputTokens: task.maxOutputTokens,
      system: buildCoreSystemPrompt({ today, orgName: org.organizationName, organizationType: org.organizerType }),
      prompt: body.prompt,
      output: Output.object({ schema: blueprintCoreDraftSchema, name: "event_blueprint_core" }),
    };
    // A provider error during streaming reaches `result.output` only as "no output generated"; the real error
    // (quota, busy model, bad key …) is kept here so it can be classified and shown.
    let streamError: unknown = null;
    const result = streamText({
      ...request, model: modelFor("eventBuilder"), providerOptions: structuredProviderOptions(),
      onError: ({ error }) => { streamError ??= error; },
    });

    // The stream is a preview only. Nothing is applied from it: the validated core becomes a
    // PENDING proposal that the organizer must apply explicitly.
    after(() =>
      finalizeCoreGeneration({
        org, generationId, today, startedAt, organizerModules: body.modules,
        output: () => Promise.resolve(result.output).catch((e) => { throw streamError ?? e; }),
        usage: () => Promise.resolve(result.totalUsage),
        // the main model failed (busy, quota, not available, cut-off): same request once on the fallback model
        fallback: async () => {
          const r = await generateText({ ...request, model: modelFor("eventBuilder", { fallback: true }) });
          return { output: r.output, usage: r.totalUsage };
        },
      }),
    );

    return result.toTextStreamResponse({ headers: { "x-generation-id": generationId } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
