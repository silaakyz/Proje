/**
 * GET  /api/surveys/:surveyId/responses?organizationId=… — all responses with answers and spend lines
 *      (survey.manage; RLS: owner/admin).
 * POST /api/surveys/:surveyId/responses { organizationId, answers, sensitiveConsent? } — staff types in a
 *      respondent's answers (survey.collect). 201; 409 SURVEY_NOT_OPEN; 422 INVALID_ANSWERS with `problems`.
 */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { listResponses, staffResponseSchema, submitStaffResponse } from "@/server/surveys/survey-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ surveyId: string }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const surveyId = await uuidSegment(params, "surveyId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "survey.manage");
    return Response.json({ responses: await listResponses(await getUserDb(), organizationId, surveyId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const surveyId = await uuidSegment(params, "surveyId");
    const input = staffResponseSchema.parse(await readJson(req));
    const me = await requireOrgPermission(input.organizationId, "survey.collect");
    return Response.json({ response: await submitStaffResponse(input.organizationId, surveyId, me.userId, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
