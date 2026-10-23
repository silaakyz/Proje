/**
 * GET /api/events/:eventId/impact/inputs?organizationId=… — the recorded price year, sourced
 *     adjustments and chosen multiplier set (org.read); `inputs: null` when nothing is recorded.
 * PUT /api/events/:eventId/impact/inputs { organizationId, priceYear, deadweight?, displacement?, leakage?,
 *     multiplierSetId? } — each adjustment is { value 0–1, source ≥ 10 chars } or null (impact.manage).
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { getImpactInputs, impactInputsSchema, putImpactInputs } from "@/server/analytics/impact-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { ApiError, toErrorResponse } from "@/server/http";
import { adminDb } from "@/db";
import { and, eq } from "drizzle-orm";
import { events } from "@/db/schema";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ eventId: string }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    const [ev] = await adminDb.select({ id: events.id }).from(events).where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
    if (!ev) throw new ApiError(404, "Event not found");
    return Response.json({ inputs: await getImpactInputs(organizationId, eventId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = impactInputsSchema.parse(await readJson(req));
    const me = await requireOrgPermission(input.organizationId, "impact.manage");
    return Response.json({ inputs: await putImpactInputs(eventId, me.userId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
