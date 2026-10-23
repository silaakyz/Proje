/**
 * PATCH /api/multiplier-sets/:setId { organizationId, isActive } — (de)activate a set (impact.manage).
 * Coefficients are never edited: record a new set instead, so stored runs stay reproducible.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { multiplierSetActiveSchema, setMultiplierSetActive } from "@/server/analytics/impact-service";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ setId: string }> }): Promise<Response> {
  try {
    const setId = await uuidSegment(params, "setId");
    const input = multiplierSetActiveSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "impact.manage");
    return Response.json({ multiplierSet: await setMultiplierSetActive(setId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
