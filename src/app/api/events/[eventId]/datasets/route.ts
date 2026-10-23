/**
 * GET  /api/events/:eventId/datasets?organizationId — the organization's own tables for the event: columns, mapping,
 *      summaries and interpretations, no rows (org.read) → { datasets, aiAvailable }.
 * POST /api/events/:eventId/datasets { organizationId, fileName, content (base64), sheet?, name? } — upload an Excel
 *      (.xlsx) or CSV file (data.manage) → 201 { id, sheets, sheet, rows, columns, droppedColumns, notes }.
 *      422 DATASET_XLS | DATASET_TYPE | DATASET_UNREADABLE | DATASET_NO_TABLE | DATASET_SHEET; 413 DATASET_TOO_LARGE.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { aiAvailable, listDatasets, uploadDataset, uploadDatasetSchema } from "@/server/datasets/dataset-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ datasets: await listDatasets(organizationId, eventId), aiAvailable: aiAvailable() }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = uploadDatasetSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "data.manage");
    return Response.json(await uploadDataset(access, eventId, input), { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
