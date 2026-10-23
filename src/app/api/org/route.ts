/** PATCH /api/org { organizationId, name?, organizerType? } — edit the organization's settings (org.manage). */
import { requireOrgPermission } from "@/server/auth/org-access";
import { updateOrganization, updateOrganizationSchema } from "@/server/org/team-service";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function PATCH(req: Request): Promise<Response> {
  try {
    const input = updateOrganizationSchema.parse(await readJson(req));
    const access = await requireOrgPermission(input.organizationId, "org.manage");
    return Response.json({ organization: await updateOrganization(access, input) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
