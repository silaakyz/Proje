/**
 * DELETE /api/registrations/:registrationId?organizationId — deletes one person's personal data (KVKK m. 7 / m. 11
 * request); their ticket stays as an anonymous count (attendee.write). 204 · 404.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { deleteRegistration } from "@/server/registration/registration-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function DELETE(req: Request, { params }: { params: Promise<{ registrationId: string }> }): Promise<Response> {
  try {
    const registrationId = await uuidSegment(params, "registrationId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "attendee.write");
    await deleteRegistration(organizationId, registrationId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
