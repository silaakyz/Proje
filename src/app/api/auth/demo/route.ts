/**
 * Demo sign-in for presentations. GET tells the sign-in page whether a demo account is configured;
 * POST signs in as that account (session cookie, same as /api/auth/sign-in).
 * The credentials live only in server env (DEMO_EMAIL, DEMO_PASSWORD) and are never sent to the browser.
 * The demo account is an ordinary member of its own organization: RLS and permissions apply unchanged.
 * Leave the variables unset in production to turn it off.
 */
import { credentialsSchema, signIn } from "@/server/auth/session";
import { ApiError, toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

function demoCredentials() {
  const parsed = credentialsSchema.safeParse({ email: process.env.DEMO_EMAIL?.trim(), password: process.env.DEMO_PASSWORD });
  return parsed.success ? parsed.data : null;
}

export async function GET(): Promise<Response> {
  const creds = demoCredentials();
  return Response.json({ enabled: !!creds, email: creds?.email ?? null }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const creds = demoCredentials();
    if (!creds) throw new ApiError(404, "Demo account is not configured", "DEMO_DISABLED");
    const { user } = await signIn(req, creds);
    return Response.json({ user }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
