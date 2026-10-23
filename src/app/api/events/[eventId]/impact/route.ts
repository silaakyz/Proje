/**
 * GET /api/events/:eventId/impact?organizationId=…[&level=SPEND|ATTRIBUTABLE_SPEND|ECONOMIC_IMPACT]
 * Impact readiness (org.read): the data-sufficiency gate and response counts on the event's real data,
 * the recorded inputs and the latest stored run. No figure here (`figures: null`): figures come only
 * from stored runs (POST /api/events/:eventId/impact/runs). See src/server/analytics/impact-service.ts.
 */
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-access";
import { IMPACT_LEVELS, impactReadiness } from "@/server/analytics/impact-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { ApiError, toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    const level = z.enum(IMPACT_LEVELS).safeParse(new URL(req.url).searchParams.get("level") ?? "ECONOMIC_IMPACT");
    if (!level.success) throw new ApiError(400, `level must be one of ${IMPACT_LEVELS.join(", ")}`);
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ impact: await impactReadiness(organizationId, eventId, level.data) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
