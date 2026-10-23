/**
 * POST /api/account/password { currentPassword, newPassword } — session only. Changes the password and ends the
 * account's other sessions (this one stays). 403 WRONG_PASSWORD, 429 RATE_LIMITED.
 */
import { getVerifiedClaims } from "@/db";
import { changePassword, changePasswordSchema } from "@/server/auth/session";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const claims = await getVerifiedClaims();
    const input = changePasswordSchema.parse(await readJson(req));
    return Response.json(await changePassword(req, claims.sub, input));
  } catch (e) {
    return toErrorResponse(e);
  }
}
