/**
 * PATCH /api/kpis/:kpiId { organizationId, status?: "ACTIVE" | "DROPPED", targetValue?: number | null } —
 * the organizer activates or drops a proposed KPI and/or sets its target (event.write).
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { updateKpi, updateKpiSchema } from "@/server/planning/kpi-service";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ kpiId: string }> }): Promise<Response> {
  try {
    const kpiId = await uuidSegment(params, "kpiId");
    const input = updateKpiSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "event.write");
    return Response.json({ kpi: await updateKpi(kpiId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
