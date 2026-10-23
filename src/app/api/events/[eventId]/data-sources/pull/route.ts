/**
 * POST /api/events/:eventId/data-sources/pull { organizationId, provider? } — pull one provider's source, or every
 * enabled source of the event, now (data.manage) → { results: [{ provider, status: OK | ERROR, summary? | error? }] }.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { pullEvent, pullProvider, pullSchema } from "@/server/connectors/data-sources-service";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = pullSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "data.manage");
    const results = input.provider
      ? [await pullProvider(input.organizationId, eventId, input.provider)]
      : await pullEvent(input.organizationId, eventId);
    return Response.json({ results });
  } catch (e) {
    return toErrorResponse(e);
  }
}
