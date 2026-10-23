/** POST /api/events/:eventId/archive { organizationId, archived } — archive or restore an event (event.write). */
import { requireOrgPermission } from "@/server/auth/org-access";
import { archiveSchema, setEventArchived } from "@/server/events/lifecycle-service";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = archiveSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "event.write");
    return Response.json({ event: await setEventArchived(access, eventId, input.archived) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
