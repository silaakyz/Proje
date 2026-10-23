/**
 * The event's public KVKK-compliant registration form (attendee.write).
 * GET ?organizationId → { form: { token, enabled, ticketType, capacity, opensAt, closesAt, collectPhone, privacyNotice,
 *       noticeVersion, marketingConsentText, retentionDays, registered, state, defaults } } (created disabled on first use)
 * PUT { organizationId, enabled, ticketType, capacity, opensAt, closesAt, collectPhone, privacyNotice,
 *       marketingConsentText, retentionDays } → { form }; a changed notice or consent text raises noticeVersion.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { getRegistrationForm, updateRegistrationForm } from "@/server/registration/registration-service";
import { registrationFormSchema } from "@/lib/registration/notice";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    const me = await requireOrgPermission(organizationId, "attendee.write");
    return Response.json({ form: await getRegistrationForm(organizationId, eventId, me.userId) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const input = registrationFormSchema.parse(await readJson(req));
    const me = await requireOrgPermission(input.organizationId, "attendee.write");
    return Response.json({ form: await updateRegistrationForm(input.organizationId, eventId, me.userId, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
