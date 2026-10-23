/**
 * POST /api/multiplier-sets/from-io { organizationId, name, region: null | {…} } — store the multipliers computed from
 * TÜİK's 2023 input-output tables as a multiplier set (impact.manage). National → method NATIONAL; with a region →
 * FLQ for that NUTS-2 region. 201 { multiplierSet }.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { createIoMultiplierSet, ioCreateSchema } from "@/server/analytics/io-service";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const input = ioCreateSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "impact.manage");
    return Response.json({ multiplierSet: await createIoMultiplierSet(access.userId, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
