/**
 * POST /api/datasets/:datasetId/interpret { organizationId } — the model writes an interpretation of the table's
 * computed figures (only the numbers, never rows) (data.manage) → { text, model, at }. 409 DATASET_NOT_CONFIRMED;
 * 503 AI_NOT_CONFIGURED.
 */
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-access";
import { interpretDataset } from "@/server/datasets/dataset-service";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({ organizationId: z.uuid() });

export async function POST(req: Request, { params }: { params: Promise<{ datasetId: string }> }): Promise<Response> {
  try {
    const datasetId = await uuidSegment(params, "datasetId");
    const input = schema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "data.manage");
    return Response.json(await interpretDataset(access, datasetId));
  } catch (e) {
    return toErrorResponse(e);
  }
}
