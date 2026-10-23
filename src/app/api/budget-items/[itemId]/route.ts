/**
 * PATCH  /api/budget-items/:itemId { organizationId, …fields } — edit a budget line (budget.manage) → { item }.
 * DELETE /api/budget-items/:itemId?organizationId — delete it (budget.manage) → 204.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { deleteBudgetItem, updateBudgetItem, updateBudgetItemSchema } from "@/server/finance/budget-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ itemId: string }> }): Promise<Response> {
  try {
    const itemId = await uuidSegment(params, "itemId");
    const input = updateBudgetItemSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "budget.manage");
    return Response.json({ item: await updateBudgetItem(input.organizationId, itemId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ itemId: string }> }): Promise<Response> {
  try {
    const itemId = await uuidSegment(params, "itemId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "budget.manage");
    await deleteBudgetItem(organizationId, itemId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
