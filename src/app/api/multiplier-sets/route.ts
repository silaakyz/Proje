/**
 * GET  /api/multiplier-sets?organizationId=… — the organization's multiplier sets with coefficients (org.read, RLS).
 * POST /api/multiplier-sets { organizationId, name, source, ioBaseYear, priceYear, nuts2Code, method,
 *      multiplierType, coefficients[] } — one row per spend category (impact.manage). 201.
 */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { createMultiplierSet, listMultiplierSets, multiplierSetSchema } from "@/server/analytics/impact-service";
import { readJson, uuidParam } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ multiplierSets: await listMultiplierSets(await getUserDb(), organizationId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = multiplierSetSchema.parse(await readJson(req));
    const me = await requireOrgPermission(input.organizationId, "impact.manage");
    return Response.json({ multiplierSet: await createMultiplierSet(me.userId, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
