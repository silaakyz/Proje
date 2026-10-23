/**
 * POST /api/events/:eventId/attendees/cancel { organizationId, attendeeIds[] (1–500) } — voids tickets issued
 * by mistake (attendee.write). 200 { cancelled, alreadyCancelled, checkedIn, notFound } (ids per group;
 * checked-in tickets are not voided). A voided ticket's scan answers 409 TICKET_CANCELLED.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { cancelTickets, cancelTicketsSchema } from "@/server/logistics/checkin";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = cancelTicketsSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "attendee.write");
    return Response.json(await cancelTickets(eventId, input));
  } catch (e) {
    return toErrorResponse(e);
  }
}
