/** PATCH /api/tasks/:taskId { organizationId, status } — move a task (task.update_status, under RLS). */
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { updateTaskStatus, updateTaskStatusSchema } from "@/server/planning/planning-read";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ taskId: string }> }): Promise<Response> {
  try {
    const taskId = await uuidSegment(params, "taskId");
    const input = updateTaskStatusSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "task.update_status");
    return Response.json({ task: await updateTaskStatus(await getUserDb(), taskId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
