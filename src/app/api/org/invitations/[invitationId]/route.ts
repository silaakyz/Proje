/** DELETE /api/org/invitations/:invitationId?organizationId — revoke an open invitation (member.manage). 204. */
import { requireOrgPermission } from "@/server/auth/org-access";
import { revokeInvitation } from "@/server/org/team-service";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function DELETE(req: Request, { params }: { params: Promise<{ invitationId: string }> }): Promise<Response> {
  try {
    const invitationId = await uuidSegment(params, "invitationId");
    const organizationId = uuidParam(req, "organizationId");
    const access = await requireOrgPermission(organizationId, "member.manage");
    await revokeInvitation(access, invitationId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
