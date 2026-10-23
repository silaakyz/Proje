/**
 * POST /api/events/:eventId/report { organizationId, summary? } → application/pdf (org.read).
 * The event report from stored records (src/server/reports/event-report.ts); budget figures only for budget.read.
 * `summary` = the assistant's management-summary draft from the Raporlar page, printed as a labelled draft annex.
 */
import { z } from "zod";
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { collectEventReport, renderEventReportPdf, reportFileName } from "@/server/reports/event-report";
import { readJson, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

const schema = z.object({ organizationId: z.uuid(), summary: z.string().max(40_000).nullish() });

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = schema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "org.read");
    const data = await collectEventReport(access, await getUserDb(), eventId);
    const pdf = await renderEventReportPdf(data, input.summary);
    const name = reportFileName(data.event.title, data.generatedAt);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
