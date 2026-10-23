/** GET /api/events/:eventId/attendees/export?organizationId — the event's tickets as a CSV file (attendee.read). */
import { requireOrgPermission } from "@/server/auth/org-access";
import { attendeesCsv } from "@/server/events/lifecycle-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    const access = await requireOrgPermission(organizationId, "attendee.read");
    const csv = await attendeesCsv(access, eventId);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="biletler-${eventId.slice(0, 8)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
