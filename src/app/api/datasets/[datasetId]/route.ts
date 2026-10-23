/**
 * GET    /api/datasets/:datasetId?organizationId — columns and the first 15 rows, for the mapping review (data.manage).
 * PATCH  /api/datasets/:datasetId { organizationId, name?, mapping: [{ key, role }] } — confirm the column mapping
 *        (data.manage); only confirmed tables feed metrics and reports. 422 DATASET_MAPPING with the problems.
 * DELETE /api/datasets/:datasetId?organizationId — delete the table (data.manage) → 204.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { confirmDataset, confirmDatasetSchema, datasetPreview, deleteDataset } from "@/server/datasets/dataset-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ datasetId: string }> }): Promise<Response> {
  try {
    const datasetId = await uuidSegment(params, "datasetId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "data.manage");
    return Response.json(await datasetPreview(organizationId, datasetId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ datasetId: string }> }): Promise<Response> {
  try {
    const datasetId = await uuidSegment(params, "datasetId");
    const input = confirmDatasetSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "data.manage");
    return Response.json(await confirmDataset(access, datasetId, input));
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ datasetId: string }> }): Promise<Response> {
  try {
    const datasetId = await uuidSegment(params, "datasetId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "data.manage");
    await deleteDataset(organizationId, datasetId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
