/**
 * GET /api/surveys/:surveyId?organizationId=… — the survey with its questions (org.read); `publicToken` only
 * for survey.manage. Staff use it to type in responses (POST …/responses).
 * POST /api/surveys/:surveyId { organizationId, action: "open" | "close" } (survey.manage).
 * open: DRAFT → OPEN and creates the public link token; close: OPEN → CLOSED. 409 INVALID_TRANSITION,
 * 422 NO_QUESTIONS.
 */
import { permissionsFor, requireOrgPermission } from "@/server/auth/org-access";
import { getSurveyDetail, setSurveyStatus, surveyActionSchema } from "@/server/surveys/survey-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ surveyId: string }> }): Promise<Response> {
  try {
    const surveyId = await uuidSegment(params, "surveyId");
    const organizationId = uuidParam(req, "organizationId");
    const me = await requireOrgPermission(organizationId, "org.read");
    return Response.json({ survey: await getSurveyDetail(organizationId, surveyId, permissionsFor(me.role).includes("survey.manage")) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ surveyId: string }> }): Promise<Response> {
  try {
    const surveyId = await uuidSegment(params, "surveyId");
    const input = surveyActionSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "survey.manage");
    return Response.json({ survey: await setSurveyStatus(input.organizationId, surveyId, input.action) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
