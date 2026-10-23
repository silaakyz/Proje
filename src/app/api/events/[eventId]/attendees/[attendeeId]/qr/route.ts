/**
 * GET /api/events/:eventId/attendees/:attendeeId/qr?organizationId=… — the attendee's QR entry token
 * (attendee.write). The frontend renders it as a QR code; the door scanner posts it to …/checkin.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { getQrToken } from "@/server/logistics/checkin";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string; attendeeId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const attendeeId = await uuidSegment(params, "attendeeId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "attendee.write");
    return Response.json(await getQrToken(organizationId, eventId, attendeeId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
