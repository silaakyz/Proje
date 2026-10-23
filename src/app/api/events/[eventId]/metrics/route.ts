/**
 * GET /api/events/:eventId/metrics?organizationId=… — every KPI the platform can compute for the event, from the
 * organization's KPI reference (src/lib/kpi). Aggregates only (org.read). Values: { id, value | null, reason?, n?,
 * interval?, note? }.
 */
import { requireOrgPermission, roleHas } from "@/server/auth/org-access";
import { eventKpiValues } from "@/server/analytics/kpi-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    const access = await requireOrgPermission(organizationId, "org.read");
    const finance = roleHas(access.role, "budget.read");
    return Response.json(await eventKpiValues(organizationId, eventId, { finance }), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
