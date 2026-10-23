/**
 * GET /api/public/surveys/:token — public, no session: the questions of an OPEN survey behind its link.
 * 404 unknown link · 409 SURVEY_NOT_OPEN. Exposes nothing but the survey's own title, intro and questions.
 */
import { getPublicSurvey } from "@/server/surveys/survey-service";
import { toErrorResponse } from "@/server/http";
import { limitPublicSurveyRequest } from "@/server/surveys/public-rate-limit";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await params;

    const blocked = await limitPublicSurveyRequest(req, token, "read");
    if (blocked) return blocked;

    return Response.json(
      { survey: await getPublicSurvey(token) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}
