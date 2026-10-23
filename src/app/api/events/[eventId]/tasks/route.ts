/** GET /api/events/:eventId/tasks?organizationId=… — the event's tasks (org.read, under RLS). */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { listTasks } from "@/server/planning/planning-read";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "org.read");
    return Response.json({ tasks: await listTasks(await getUserDb(), organizationId, eventId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
