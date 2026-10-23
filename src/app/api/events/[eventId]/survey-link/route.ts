/**
 * The event's single survey link — one QR code for all measurement forms (survey.manage).
 *
 * GET  ?organizationId → { link: { token, roleQuestion, customized, routes: [{ key, label, audiences }],
 *        surveys: [{ audience, surveyId, title, version, status, accepting, questions }] } }. The link is created on the
 *        first call, so the QR code can be printed before the surveys open.
 * PUT  { organizationId, roleQuestion | null, routes | null } — the first question and its options (each opens one or
 *        more audiences' surveys); null = defaults. 422 SURVEY_LINK_INVALID / validation errors.
 * POST { organizationId, action: "open_all" } → { opened: [audience], skipped: [{ audience, reason }], link }.
 */
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-access";
import { eventSurveyLinkInfo, openAllEventSurveys, updateEventSurveyLink, updateSurveyLinkSchema } from "@/server/surveys/survey-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    const me = await requireOrgPermission(organizationId, "survey.manage");
    return Response.json({ link: await eventSurveyLinkInfo(organizationId, eventId, me.userId) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = updateSurveyLinkSchema.parse(await readJson(req));
    const me = await requireOrgPermission(input.organizationId, "survey.manage");
    return Response.json({ link: await updateEventSurveyLink(input.organizationId, eventId, me.userId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

const actionSchema = z.object({ organizationId: z.uuid(), action: z.literal("open_all") });

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = actionSchema.parse(await readJson(req));
    const me = await requireOrgPermission(input.organizationId, "survey.manage");
    const result = await openAllEventSurveys(input.organizationId, eventId);
    return Response.json({ ...result, link: await eventSurveyLinkInfo(input.organizationId, eventId, me.userId) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
