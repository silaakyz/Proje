/**
 * GET   /api/events/:eventId?organizationId=… — detail: profile, modules, counts (org.read).
 * PATCH /api/events/:eventId { organizationId, title?, status?, startDate?, endDate? } (event.write).
 * Another organization's event is a 404 (never distinguishable from a missing one).
 */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { getEventDetail, updateEvent, updateEventSchema } from "@/server/events/events-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ eventId: string }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ event: await getEventDetail(await getUserDb(), organizationId, eventId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = updateEventSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "event.write");
    return Response.json({ event: await updateEvent(await getUserDb(), eventId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
