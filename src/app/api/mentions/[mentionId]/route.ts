/** PATCH /api/mentions/:mentionId { organizationId, status: CANDIDATE | VERIFIED | REJECTED } — review a press mention (data.manage). */
import { requireOrgPermission } from "@/server/auth/org-access";
import { reviewMention, reviewMentionSchema } from "@/server/connectors/data-sources-service";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ mentionId: string }> }): Promise<Response> {
  try {
    const mentionId = await uuidSegment(params, "mentionId");
    const input = reviewMentionSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "data.manage");
    return Response.json({ mention: await reviewMention(access, mentionId, input.status) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
