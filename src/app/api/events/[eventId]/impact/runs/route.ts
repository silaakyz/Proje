/**
 * GET  /api/events/:eventId/impact/runs?organizationId=… — stored calculation runs, newest first (org.read, RLS).
 * POST /api/events/:eventId/impact/runs { organizationId, level? } — runs the engine on the event's current
 *      data and stores an immutable run with its checks, inputs and the figures its level reached (impact.manage).
 */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { listImpactRuns, runImpactCalculation, runSchema } from "@/server/analytics/impact-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ eventId: string }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ runs: await listImpactRuns(await getUserDb(), organizationId, eventId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = runSchema.parse(await readJson(req));
    const me = await requireOrgPermission(input.organizationId, "impact.manage");
    return Response.json({ run: await runImpactCalculation(eventId, me.userId, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
