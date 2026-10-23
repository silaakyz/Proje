/**
 * POST /api/auth/password-reset { email } — public: e-mails a one-time link to set a new password, if the address has
 * an account. Always 202 (no account enumeration); 429 RATE_LIMITED; 503 EMAIL_DISABLED when e-mail is not configured.
 */
import { requestPasswordReset, resetRequestSchema } from "@/server/auth/password-reset";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    await requestPasswordReset(req, resetRequestSchema.parse(await readJson(req)));
    return Response.json({ ok: true }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
