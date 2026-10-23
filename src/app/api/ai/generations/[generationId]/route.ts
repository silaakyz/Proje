/**
 * GET /api/ai/generations/:generationId?organizationId=… — status of an AI generation (org.read).
 * The id comes from the x-generation-id header of POST /api/ai/blueprint or /api/ai/event-builder.
 * Poll until `done`; for blueprint.core the produced proposal card is listed under `proposals`.
 */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { getGeneration } from "@/server/ai/ai-read";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ generationId: string }> }): Promise<Response> {
  try {
    const generationId = await uuidSegment(params, "generationId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ generation: await getGeneration(await getUserDb(), organizationId, generationId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
