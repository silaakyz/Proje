/**
 * GET /api/events/:eventId/data-sources?organizationId — every provider with its configuration, last pull and
 *     whether the server has the provider's credentials (names only) (org.read).
 * PUT /api/events/:eventId/data-sources { organizationId, provider, config, enabled? } — save a source (data.manage);
 *     a changed configuration drops what the old one pulled.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { listDataSources, saveDataSource, saveSourceSchema } from "@/server/connectors/data-sources-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json(await listDataSources(organizationId, eventId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = saveSourceSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "data.manage");
    const row = await saveDataSource(access, eventId, input);
    return Response.json({ source: { id: row.id, provider: row.provider, config: row.config, enabled: row.enabled } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
