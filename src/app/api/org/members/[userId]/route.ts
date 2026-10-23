/**
 * PATCH  /api/org/members/:userId { organizationId, role } — change a member's role (member.manage; owners only,
 *        never the last owner).
 * DELETE /api/org/members/:userId?organizationId — remove a member, or leave when :userId is the caller
 *        (org.read; an admin removes staff only, an owner anyone; never the last owner). 204.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { changeMemberRole, changeRoleSchema, removeMember } from "@/server/org/team-service";
import { readJson, uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ userId: string }> };

export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const userId = await uuidSegment(params, "userId");
    const input = changeRoleSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "member.manage");
    await changeMemberRole(access, userId, input.role);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const userId = await uuidSegment(params, "userId");
    const organizationId = uuidParam(req, "organizationId");
    const access = await requireOrgPermission(organizationId, "org.read");
    await removeMember(access, userId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
