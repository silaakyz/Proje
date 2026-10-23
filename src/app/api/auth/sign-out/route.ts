/** POST /api/auth/sign-out — ends the current session and clears the session cookie (204). */
import { signOut } from "@/server/auth/session";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    await signOut(req);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
