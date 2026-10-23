/**
 * GET /api/auth/options — public: what the sign-in page offers. { signUp: "open" | "invite", passwordReset: boolean }.
 */
import { signupMode } from "@/server/auth/signup-policy";
import { emailAvailable } from "@/server/email/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return Response.json({ signUp: signupMode(), passwordReset: emailAvailable(req) }, { headers: { "cache-control": "no-store" } });
}
