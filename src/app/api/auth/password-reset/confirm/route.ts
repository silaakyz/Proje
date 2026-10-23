/**
 * POST /api/auth/password-reset/confirm { token, password } — public: sets the new password with a link from the
 * reset e-mail; ends every session of the account. 200 · 400 RESET_LINK_INVALID (unknown, used or expired link).
 */
import { confirmPasswordReset, resetConfirmSchema } from "@/server/auth/password-reset";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    await confirmPasswordReset(resetConfirmSchema.parse(await readJson(req)));
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
