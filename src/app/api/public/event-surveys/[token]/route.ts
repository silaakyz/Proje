/**
 * GET /api/public/event-surveys/:token — public, no session: the event's single survey link. Returns the role
 * question ("in which role did you take part?") and, per role, the questions of that audience's OPEN survey.
 * 404 unknown link · 409 SURVEY_NOT_OPEN when no survey of the event accepts responses.
 */
import { getPublicEventSurvey } from "@/server/surveys/survey-service";
import { toErrorResponse } from "@/server/http";
import { limitPublicSurveyRequest } from "@/server/surveys/public-rate-limit";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await params;
    const blocked = await limitPublicSurveyRequest(req, token, "read");
    if (blocked) return blocked;
    return Response.json({ survey: await getPublicEventSurvey(token) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
