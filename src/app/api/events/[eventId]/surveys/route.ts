/**
 * GET /api/events/:eventId/surveys?organizationId=… — the event's surveys with question and response
 * counts (org.read). The public link token is included only for callers holding survey.manage.
 */
import { permissionsFor, requireOrgPermission } from "@/server/auth/org-access";
import { listEventSurveys } from "@/server/surveys/survey-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    const me = await requireOrgPermission(organizationId, "org.read");
    const includeToken = permissionsFor(me.role).includes("survey.manage");
    return Response.json({ surveys: await listEventSurveys(organizationId, eventId, includeToken) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
