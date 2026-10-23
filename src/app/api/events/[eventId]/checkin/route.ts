/**
 * POST /api/events/:eventId/checkin { organizationId, qrToken } — door scan (checkin.perform: owner,
 * admin, staff). 200 CHECKED_IN · 404 UNKNOWN_TICKET (forged, other event or tenant) ·
 * 409 ALREADY_CHECKED_IN (with the first check-in time) · 409 EVENT_COMPLETED.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { checkIn, checkInSchema } from "@/server/logistics/checkin";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = checkInSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "checkin.perform");
    return Response.json(await checkIn(eventId, input));
  } catch (e) {
    return toErrorResponse(e);
  }
}
