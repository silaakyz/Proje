/**
 * GET /api/events/:eventId/kpis?organizationId=… — the event's KPIs (org.read, under RLS) and their actuals:
 * `actuals[]` = engine value for metrics the platform computes, otherwise the organizer's manual entry.
 */
import { getUserDb } from "@/db";
import { requireOrgPermission, roleHas } from "@/server/auth/org-access";
import { eventKpiActuals } from "@/server/analytics/kpi-service";
import { listKpis } from "@/server/planning/planning-read";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    const access = await requireOrgPermission(organizationId, "org.read");
    const finance = roleHas(access.role, "budget.read");
    const [kpis, actuals] = await Promise.all([listKpis(await getUserDb(), organizationId, eventId), eventKpiActuals(organizationId, eventId, { finance })]);
    return Response.json({ kpis, actuals });
  } catch (e) {
    return toErrorResponse(e);
  }
}
