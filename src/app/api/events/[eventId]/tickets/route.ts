/**
 * GET /api/events/:eventId/tickets?organizationId=…[&attendeeId=…(repeatable)][&format=svg] — printable
 * tickets (attendee.write): valid (not cancelled) tickets with their QR token and the QR code as SVG.
 * `format=svg` with exactly one attendeeId returns the QR image itself (image/svg+xml).
 */
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-access";
import { listTickets } from "@/server/logistics/checkin";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { ApiError, toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    const q = new URL(req.url).searchParams;
    const ids = q.getAll("attendeeId");
    if (ids.length > 500 || ids.some((id) => !z.uuid().safeParse(id).success)) throw new ApiError(400, "attendeeId must be up to 500 UUIDs");
    const format = q.get("format") ?? "json";
    if (format !== "json" && format !== "svg") throw new ApiError(400, "format must be json or svg");
    if (format === "svg" && ids.length !== 1) throw new ApiError(400, "format=svg needs exactly one attendeeId");
    await requireOrgPermission(organizationId, "attendee.write");
    const tickets = await listTickets(organizationId, eventId, ids.length ? ids : undefined);
    if (format === "svg") {
      if (!tickets[0]) throw new ApiError(404, "Ticket not found or cancelled");
      return new Response(tickets[0].qrSvg, { headers: { "content-type": "image/svg+xml; charset=utf-8", ...NO_STORE } });
    }
    return Response.json({ tickets }, { headers: NO_STORE });
  } catch (e) {
    return toErrorResponse(e);
  }
}
