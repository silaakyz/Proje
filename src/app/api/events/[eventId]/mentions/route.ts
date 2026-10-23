/**
 * GET  /api/events/:eventId/mentions?organizationId — press-mention candidates and reviewed ones (org.read).
 * POST /api/events/:eventId/mentions { organizationId, url, title?, publishedAt? } — add a clipping by hand; stored as
 *      verified (data.manage) → 201; 409 MENTION_EXISTS when the link is already listed.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { addManualMention, addMentionSchema, listMentions } from "@/server/connectors/data-sources-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ mentions: await listMentions(organizationId, eventId) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = addMentionSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "data.manage");
    return Response.json({ mention: await addManualMention(access, eventId, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
