/**
 * POST /api/onboarding — first sign-in: create the caller's organization and make them its owner.
 * 401 without a session, 409 if the caller already has a profile, 400 for an invalid body.
 */
import { getVerifiedClaims, UnauthenticatedError } from "@/db";
import { permissionsFor } from "@/server/auth/org-access";
import { createOrganizationForUser, onboardingSchema } from "@/server/org/onboarding";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    let claims;
    try {
      claims = await getVerifiedClaims();
    } catch (e) {
      if (e instanceof UnauthenticatedError) return Response.json({ error: "Not signed in" }, { status: 401 });
      throw e;
    }
    const input = onboardingSchema.parse(await req.json().catch(() => null));
    const m = await createOrganizationForUser(claims, input);
    return Response.json({
      user: { id: m.userId, email: claims.email ?? null },
      membership: { organization: { id: m.organizationId, name: m.organizationName, organizerType: m.organizerType }, role: m.role, permissions: permissionsFor(m.role) },
    }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
