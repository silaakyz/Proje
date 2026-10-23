/**
 * GET  /api/events/:eventId/attendees?organizationId=… — attendee list, no QR tokens (attendee.read, under RLS).
 * POST /api/events/:eventId/attendees { organizationId, ticketType, quantity? } — issue tickets; the
 *      response carries each new attendee's QR token (attendee.write, server-side).
 */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { listAttendees, registerAttendees, registerSchema } from "@/server/logistics/checkin";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { ApiError, toErrorResponse } from "@/server/http";
import { adminDb } from "@/db";
import { and, eq } from "drizzle-orm";
import { events } from "@/db/schema";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ eventId: string }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "attendee.read");
    const [ev] = await adminDb.select({ id: events.id }).from(events).where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
    if (!ev) throw new ApiError(404, "Event not found");
    return Response.json({ attendees: await listAttendees(await getUserDb(), organizationId, eventId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = registerSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "attendee.write");
    return Response.json({ attendees: await registerAttendees(eventId, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
