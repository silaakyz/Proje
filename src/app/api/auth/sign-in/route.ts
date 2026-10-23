/**
 * POST /api/auth/sign-in { email, password } — sets the httpOnly session cookie; the body also returns the
 * session token for API clients (send `Authorization: Bearer <accessToken>`). Session only, no permission.
 */
import { credentialsSchema, signIn } from "@/server/auth/session";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const input = credentialsSchema.parse(await readJson(req));
    return Response.json(await signIn(req, input), { status: 200, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
