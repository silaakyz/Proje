/** GET /api/events/:eventId/uploads?organizationId — row counts of the uploaded sponsor and lead lists (data.manage). */
import { requireOrgPermission } from "@/server/auth/org-access";
import { uploadSummary } from "@/server/connectors/data-sources-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "data.manage");
    return Response.json(await uploadSummary(organizationId, eventId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
