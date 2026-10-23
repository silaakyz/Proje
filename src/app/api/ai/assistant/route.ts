/**
 * POST /api/ai/assistant { organizationId, eventId?, mode: "chat" | "report", messages[] } — streams a Turkish
 * answer (plain text) grounded in the caller's recorded data. Read-only: any member (org.read). The context
 * is read with the caller's RLS session; the model never receives personal data (tickets and survey
 * responses enter only as counts) and cannot change records.
 */
import { streamText } from "ai";
import { getUserDb } from "@/db";
import { requireOrgPermission, roleHas } from "@/server/auth/org-access";
import { AI_TASKS, assertAiConfigured, modelFor } from "@/server/ai/models";
import { assistantRequestSchema, assistantSystemPrompt, eventContext, organizationContext } from "@/server/ai/assistant";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  try {
    const body = assistantRequestSchema.parse(await readJson(req));
    const org = await requireOrgPermission(body.organizationId, "org.read");
    assertAiConfigured();
    const runAsUser = await getUserDb();
    const context = body.eventId
      ? await eventContext(runAsUser, org.organizationId, body.eventId, { finance: roleHas(org.role, "budget.read") })
      : await organizationContext(runAsUser, org);
    const task = AI_TASKS.assistant;
    const result = streamText({
      model: modelFor("assistant"),
      temperature: task.temperature,
      maxOutputTokens: task.maxOutputTokens,
      system: assistantSystemPrompt(org, body.mode, context),
      messages: body.messages,
    });
    return result.toTextStreamResponse({ headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
