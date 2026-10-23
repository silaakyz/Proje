/**
 * POST /api/events/:eventId/duplicate { organizationId, title?, startDate?, endDate? } — copy the event as a new
 * draft with its profile, modules, tasks, KPIs and surveys (event.write). 201 { event: { id, title, copied } }.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { duplicateEvent, duplicateSchema } from "@/server/events/lifecycle-service";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = duplicateSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "event.write");
    return Response.json({ event: await duplicateEvent(access, eventId, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
