/**
 * GET /api/me — who is signed in and which organization/role/permissions they have.
 * `membership: null` means the user still has to onboard (POST /api/onboarding).
 */
import { getVerifiedClaims, UnauthenticatedError } from "@/db";
import { withRls, type AppDatabase } from "@/db/rls";
import { adminDb } from "@/db";
import { findOwnMembership, permissionsFor } from "@/server/auth/org-access";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    let claims;
    try {
      claims = await getVerifiedClaims();
    } catch (e) {
      if (e instanceof UnauthenticatedError) return Response.json({ error: "Not signed in" }, { status: 401 });
      throw e;
    }
    // under RLS as the caller: only their own users row is visible
    const m = await findOwnMembership((fn) => withRls(adminDb as AppDatabase, claims, fn));
    return Response.json({
      user: { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null },
      membership: m
        ? { organization: { id: m.organizationId, name: m.organizationName, organizerType: m.organizerType }, role: m.role, permissions: permissionsFor(m.role) }
        : null,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
