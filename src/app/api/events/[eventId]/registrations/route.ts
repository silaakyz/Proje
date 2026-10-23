/**
 * GET /api/events/:eventId/registrations?organizationId — people registered through the public form, with their
 * consent records and ticket state (attendee.read: owner/admin). Personal data: shown only to these roles.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { listRegistrations } from "@/server/registration/registration-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "attendee.read");
    return Response.json({ registrations: await listRegistrations(organizationId, eventId) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
