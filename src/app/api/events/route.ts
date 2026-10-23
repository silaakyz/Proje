/**
 * GET  /api/events?organizationId=…[&status=draft|live|completed][&archived=1] — the organization's events (org.read);
 *      archived events only with archived=1 (and then only those).
 * POST /api/events { organizationId, title, startDate?, endDate? } — create an event manually (event.write).
 * Both run under RLS as the caller. AI-created events come from applying a blueprint.core proposal.
 */
import { z } from "zod";
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { createEvent, createEventSchema, EVENT_STATUSES, listEvents } from "@/server/events/events-service";
import { readJson, uuidParam } from "@/server/http-params";
import { ApiError, toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const organizationId = uuidParam(req, "organizationId");
    const status = new URL(req.url).searchParams.get("status");
    const parsedStatus = status === null ? undefined : z.enum(EVENT_STATUSES).safeParse(status);
    if (parsedStatus && !parsedStatus.success) throw new ApiError(400, "Unknown status");
    await requireOrgPermission(organizationId, "org.read");
    const archived = new URL(req.url).searchParams.get("archived") === "1";
    return Response.json({ events: await listEvents(await getUserDb(), organizationId, parsedStatus?.data, archived) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = createEventSchema.parse(await readJson(req));
    await requireOrgPermission(input.organizationId, "event.write");
    return Response.json({ event: await createEvent(await getUserDb(), input) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
