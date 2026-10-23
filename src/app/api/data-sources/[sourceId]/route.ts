/** DELETE /api/data-sources/:sourceId?organizationId — remove a source and everything it pulled (data.manage) → 204. */
import { requireOrgPermission } from "@/server/auth/org-access";
import { deleteDataSource } from "@/server/connectors/data-sources-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function DELETE(req: Request, { params }: { params: Promise<{ sourceId: string }> }): Promise<Response> {
  try {
    const sourceId = await uuidSegment(params, "sourceId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "data.manage");
    await deleteDataSource(organizationId, sourceId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
