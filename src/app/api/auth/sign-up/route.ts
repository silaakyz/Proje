/**
 * POST /api/auth/sign-up { email, password } — creates the account and signs it in (httpOnly session cookie;
 * the body also returns the session token for API clients). 409 EMAIL_IN_USE when the address is taken.
 * Session only, no permission.
 */
import { credentialsSchema, signUp } from "@/server/auth/session";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const input = credentialsSchema.parse(await readJson(req));
    return Response.json(await signUp(req, input), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
