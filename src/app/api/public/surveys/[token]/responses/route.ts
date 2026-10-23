/**
 * POST /api/public/surveys/:token/responses { answers, sensitiveConsent? } — public, no session: one
 * anonymous response to an OPEN survey. 201 { submittedAt } · 404 unknown link · 409 SURVEY_NOT_OPEN ·
 * 422 INVALID_ANSWERS. No identity is stored; there is no rate limit yet (see docs/impact-open-decisions.md).
 */
import { publicResponseSchema, submitPublicResponse } from "@/server/surveys/survey-service";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";
import { limitPublicSurveyRequest } from "@/server/surveys/public-rate-limit";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await params;

    const blocked = await limitPublicSurveyRequest(req, token, "submit");
    if (blocked) return blocked;

    const input = publicResponseSchema.parse(await readJson(req));

    return Response.json(
      { response: await submitPublicResponse(token, input) },
      { status: 201 },
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}


