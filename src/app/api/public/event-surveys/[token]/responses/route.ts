/**
 * POST /api/public/event-surveys/:token/responses { role, answers, sensitiveConsent? } — public, no session: one
 * anonymous response through the event's single link, stored on the OPEN survey of the chosen role (audience).
 * 201 { submittedAt } · 404 unknown link · 409 SURVEY_NOT_OPEN · 422 INVALID_ANSWERS. Rate limited like /surveys.
 */
import { publicEventResponseSchema, submitPublicEventResponse } from "@/server/surveys/survey-service";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";
import { limitPublicSurveyRequest } from "@/server/surveys/public-rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await params;
    const blocked = await limitPublicSurveyRequest(req, token, "submit");
    if (blocked) return blocked;
    const input = publicEventResponseSchema.parse(await readJson(req));
    return Response.json({ response: await submitPublicEventResponse(token, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
