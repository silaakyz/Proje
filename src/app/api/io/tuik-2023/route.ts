/**
 * POST /api/io/tuik-2023 { organizationId, region: null | { nuts2Code, delta, deltaSource, regional, national, dataSource } }
 * — preview of the multipliers per spend category computed from TÜİK's 2023 input-output tables (org.read; nothing stored).
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { ioMultipliers, ioPreviewSchema } from "@/server/analytics/io-service";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const input = ioPreviewSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "org.read");
    return Response.json(ioMultipliers(input.region));
  } catch (e) {
    return toErrorResponse(e);
  }
}
