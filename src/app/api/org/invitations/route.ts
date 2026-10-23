/**
 * GET  /api/org/invitations?organizationId — open invitations (member.manage).
 * POST /api/org/invitations { organizationId, email, role: "admin" | "staff" } — create or renew an invitation
 *      (member.manage; admins invite staff only). 201 { invitation, token, emailed, emailError? }: the token is shown
 *      once; the invitation link is /davet/<token>. With e-mail configured (src/server/email/mailer.ts) the link is
 *      also e-mailed to the address; a failed e-mail does not undo the invitation (the link can still be shared).
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { createInvitation, inviteSchema, listInvitations } from "@/server/org/team-service";
import { readJson, uuidParam } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";
import { appBaseUrl, emailAvailable, EmailError, invitationMail, sendMail } from "@/server/email/mailer";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const organizationId = uuidParam(req, "organizationId");
    const access = await requireOrgPermission(organizationId, "member.manage");
    return Response.json({ invitations: await listInvitations(access) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = inviteSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "member.manage");
    const created = await createInvitation(access, input);
    let emailed = false;
    let emailError: string | undefined;
    if (emailAvailable(req)) {
      try {
        await sendMail(invitationMail({
          to: created.invitation.email, organization: access.organizationName, role: created.invitation.role,
          invitedBy: created.invitation.invitedByEmail, url: `${appBaseUrl(req)}/davet/${created.token}`, expiresAt: new Date(created.invitation.expiresAt),
        }));
        emailed = true;
      } catch (e) {
        emailError = e instanceof EmailError ? e.message : "E-posta gönderilemedi.";
      }
    }
    return Response.json({ ...created, emailed, ...(emailError ? { emailError } : {}) }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
