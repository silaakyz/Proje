/** GET /api/org/members?organizationId — the organization's members with their roles (org.read). */
import { requireOrgPermission } from "@/server/auth/org-access";
import { listMembers } from "@/server/org/team-service";
import { uuidParam } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const organizationId = uuidParam(req, "organizationId");
    const access = await requireOrgPermission(organizationId, "org.read");
    return Response.json({ members: await listMembers(access) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
