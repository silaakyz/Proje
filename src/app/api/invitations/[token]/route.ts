/**
 * GET  /api/invitations/:token — public (whoever holds the link): organization, invited address, role, state.
 * POST /api/invitations/:token — session only: the signed-in account (same address, no organization yet) joins.
 * Both are rate limited per client IP.
 */
import { getVerifiedClaims } from "@/db";
import { permissionsFor } from "@/server/auth/org-access";
import { acceptInvitation, describeInvitation } from "@/server/org/team-service";
import { toErrorResponse } from "@/server/http";
import { clientKey, hitRateLimit, RateLimitUnavailableError, rateLimitUnavailable, tooManyRequests } from "@/server/rate-limit";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

async function limited(req: Request) {
  try {
    const r = await hitRateLimit(`invitation:ip:${clientKey(req)}`, 30);
    return r.ok ? null : tooManyRequests(r.retryAfter);
  } catch (e) {
    if (e instanceof RateLimitUnavailableError && process.env.NODE_ENV === "production") return rateLimitUnavailable();
    return null;
  }
}

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const blocked = await limited(req);
    if (blocked) return blocked;
    const { token } = await params;
    return Response.json({ invitation: await describeInvitation(token) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const blocked = await limited(req);
    if (blocked) return blocked;
    const claims = await getVerifiedClaims();
    const { token } = await params;
    const m = await acceptInvitation(claims, token);
    return Response.json({
      membership: { organization: { id: m.organizationId, name: m.organizationName, organizerType: m.organizerType }, role: m.role, permissions: permissionsFor(m.role) },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
