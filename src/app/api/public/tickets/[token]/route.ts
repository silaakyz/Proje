/**
 * GET /api/public/tickets/:qrToken — public, the ticket page /bilet/:qrToken: event, ticket type, the registrant's name
 * (if registered through the form) and whether it was used or cancelled. The link itself is the ticket. 404 unknown.
 */
import { getPublicTicket } from "@/server/registration/registration-service";
import { limitPublicSurveyRequest } from "@/server/surveys/public-rate-limit";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await params;
    const blocked = await limitPublicSurveyRequest(req, `ticket:${token}`, "read");
    if (blocked) return blocked;
    return Response.json({ ticket: await getPublicTicket(token) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
