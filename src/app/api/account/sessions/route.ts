/**
 * GET    /api/account/sessions — session only: number of the account's active sessions.
 * DELETE /api/account/sessions — session only: sign out everywhere else (this session stays).
 */
import { getVerifiedClaims } from "@/db";
import { activeSessionCount, signOutOtherSessions } from "@/server/auth/session";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const claims = await getVerifiedClaims();
    return Response.json({ activeSessions: await activeSessionCount(claims.sub) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const claims = await getVerifiedClaims();
    return Response.json(await signOutOtherSessions(req, claims.sub));
  } catch (e) {
    return toErrorResponse(e);
  }
}
