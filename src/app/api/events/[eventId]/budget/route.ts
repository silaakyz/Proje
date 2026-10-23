/**
 * GET  /api/events/:eventId/budget?organizationId — budget lines and planned/actual totals (budget.read).
 * POST /api/events/:eventId/budget { organizationId, kind, category, label, planned?, actual?, quantity?, costBehavior?,
 *      supplierLocal?, fundedExternally?, notes? } — add a line (budget.manage) → 201 { item }.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { createBudgetItem, createBudgetItemSchema, listBudget } from "@/server/finance/budget-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "budget.read");
    return Response.json(await listBudget(organizationId, eventId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = createBudgetItemSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "budget.manage");
    return Response.json({ item: await createBudgetItem(access, eventId, input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
