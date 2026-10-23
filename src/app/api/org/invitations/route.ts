/**
 * GET  /api/org/invitations?organizationId — open invitations (member.manage).
 * POST /api/org/invitations { organizationId, email, role: "admin" | "staff" } — create or renew an invitation
 *      (member.manage; admins invite staff only). 201 { invitation, token }: the token is shown once; the
 *      invitation link is /davet/<token>.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { createInvitation, inviteSchema, listInvitations } from "@/server/org/team-service";
import { readJson, uuidParam } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

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
    return Response.json(await createInvitation(access, input), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
