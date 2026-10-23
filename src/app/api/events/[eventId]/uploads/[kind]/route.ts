/**
 * POST   /api/events/:eventId/uploads/:kind { organizationId, csv } — kind = sponsors | leads: replace the event's list
 *        with the CSV (all-or-nothing; personal columns are dropped) (data.manage) → { stored, issues[], droppedColumns[],
 *        unknownColumns[] }; 422 CSV_INVALID with the same body when a row is invalid.
 * DELETE /api/events/:eventId/uploads/:kind?organizationId — delete the list (data.manage) → 204.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { clearUpload, uploadCsvSchema, uploadLeads, uploadSponsors } from "@/server/connectors/data-sources-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { ApiError, toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

async function kindOf(params: Promise<{ eventId: string; kind: string }>) {
  const { kind } = await params;
  if (kind !== "sponsors" && kind !== "leads") throw new ApiError(404, "Unknown upload");
  return kind;
}

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string; kind: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const kind = await kindOf(params);
    const input = uploadCsvSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "data.manage");
    const r = kind === "sponsors" ? await uploadSponsors(input.organizationId, eventId, input.csv) : await uploadLeads(input.organizationId, eventId, input.csv);
    return r.issues.length
      ? Response.json({ error: "CSV has invalid rows", code: "CSV_INVALID", ...r }, { status: 422 })
      : Response.json(r);
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ eventId: string; kind: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const kind = await kindOf(params);
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "data.manage");
    await clearUpload(organizationId, eventId, kind);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
