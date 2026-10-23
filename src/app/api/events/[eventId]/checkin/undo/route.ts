/**
 * POST /api/events/:eventId/checkin/undo { organizationId, attendeeId } — reverses a mistaken check-in
 * (attendee.write). 200 CHECK_IN_REVERSED · 404 unknown attendee · 409 NOT_CHECKED_IN · 409 EVENT_COMPLETED.
 * The live counter (…/checkins, …/checkins/stream) reflects it on its next poll.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { undoCheckIn, undoCheckInSchema } from "@/server/logistics/checkin";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = undoCheckInSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "attendee.write");
    return Response.json(await undoCheckIn(eventId, input));
  } catch (e) {
    return toErrorResponse(e);
  }
}
