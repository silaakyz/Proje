/** GET /api/events/:eventId/budget/export?organizationId — the event's budget as a CSV file (budget.read). */
import { requireOrgPermission } from "@/server/auth/org-access";
import { budgetCsv } from "@/server/finance/budget-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "budget.read");
    return new Response(await budgetCsv(organizationId, eventId), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="butce-${eventId.slice(0, 8)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
