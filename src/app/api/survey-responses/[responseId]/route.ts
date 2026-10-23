/**
 * PATCH /api/survey-responses/:responseId { organizationId, isExcluded, reason? } — exclude a response
 * from every calculation (a reason is required) or include it again (survey.manage).
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { exclusionSchema, setResponseExclusion } from "@/server/surveys/survey-service";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ responseId: string }> }): Promise<Response> {
  try {
    const responseId = await uuidSegment(params, "responseId");
    const input = exclusionSchema.parse(await readJson(req));
    const me = await requireOrgPermission(input.organizationId, "survey.manage");
    return Response.json({ response: await setResponseExclusion(input.organizationId, responseId, me.userId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
