/**
 * GET /api/impact-runs/:runId?organizationId=… — one stored, immutable impact run (org.read, RLS): what a
 * report cites. Same shape as the items of GET /api/events/:eventId/impact/runs.
 */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { getImpactRun } from "@/server/analytics/impact-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const runId = await uuidSegment(params, "runId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ run: await getImpactRun(await getUserDb(), organizationId, runId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
