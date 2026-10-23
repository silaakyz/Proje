/**
 * Email + password sign-up / sign-in / sign-out on PostgreSQL: accounts in auth.users (scrypt hashes,
 * src/server/auth/password.ts), sessions in auth.sessions (src/db/sessions.ts).
 *
 * The session token is set as an httpOnly cookie (browsers) and also returned in the body as
 * `session.accessToken` for API clients that send `Authorization: Bearer …` (see getVerifiedClaims).
 * Identity for every other route comes only from a valid session. Sign-in and sign-up are rate limited
 * in PostgreSQL (per IP, and per IP + address for sign-in).
 */
import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { z } from "zod";
import { adminDb } from "@/db";
import { authSessions, authUsers } from "@/db/auth-schema";
import type { AppDatabase } from "@/db/rls";
import { createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionTokenFrom } from "@/db/sessions";
import { dummyPasswordHash, hashPassword, verifyPassword } from "@/server/auth/password";
import { ApiError } from "@/server/http";
import { clientKey, hashKey, hitRateLimit, RateLimitUnavailableError } from "@/server/rate-limit";

export const credentialsSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(8).max(72),
});
type Credentials = z.infer<typeof credentialsSchema>;

const LIMITS = { signInPerIp: 30, signInPerIpAndEmail: 10, signUpPerIp: 10 } as const;

const db = () => adminDb as unknown as AppDatabase;
const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** HTTPS directly or behind a TLS-terminating proxy → Secure cookie. Plain http://localhost works too. */
function isHttps(request: Request) {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return (forwarded ?? new URL(request.url).protocol.replace(":", "")) === "https";
}

async function enforce(checks: Array<[key: string, limit: number]>) {
  try {
    for (const [key, limit] of checks) {
      const r = await hitRateLimit(key, limit);
      if (!r.ok) throw new ApiError(429, "Too many attempts, try again later", "RATE_LIMITED", { retryAfter: r.retryAfter });
    }
  } catch (e) {
    if (!(e instanceof RateLimitUnavailableError)) throw e;
    // Fail closed in production (no unlimited password guessing); keep local development usable.
    if (process.env.NODE_ENV === "production") throw new ApiError(503, "Rate limiting is unavailable", "RATE_LIMIT_UNAVAILABLE");
  }
}

async function startSession(request: Request, user: { id: string; email: string | null }) {
  const { token, expiresAt } = await createSession(db(), user.id, request.headers.get("user-agent"));
  await db().update(authUsers).set({ lastSignInAt: sql`now()` }).where(eq(authUsers.id, user.id));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(request),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return {
    user,
    session: { accessToken: token, refreshToken: null, expiresAt: Math.floor(expiresAt.getTime() / 1000) },
  };
}

/** Creates the account (no e-mail confirmation step) and signs it in. */
export async function signUp(request: Request, input: Credentials) {
  await enforce([[`auth:sign-up:ip:${clientKey(request)}`, LIMITS.signUpPerIp]]);
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const inserted = await db()
    .insert(authUsers)
    .values({ email, passwordHash })
    .onConflictDoNothing()
    .returning({ id: authUsers.id, email: authUsers.email });
  if (!inserted[0]) throw new ApiError(409, "An account with this email already exists", "EMAIL_IN_USE");
  return { ...(await startSession(request, inserted[0])), needsEmailConfirmation: false };
}

export async function signIn(request: Request, input: Credentials) {
  const email = normalizeEmail(input.email);
  const ip = clientKey(request);
  await enforce([
    [`auth:sign-in:ip:${ip}`, LIMITS.signInPerIp],
    [`auth:sign-in:ip-email:${hashKey(`${ip}\0${email}`)}`, LIMITS.signInPerIpAndEmail],
  ]);
  const [account] = await db()
    .select({ id: authUsers.id, email: authUsers.email, passwordHash: authUsers.passwordHash })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`)
    .limit(1);
  // Same work whether or not the account exists, so the response time does not reveal it.
  const valid = await verifyPassword(input.password, account?.passwordHash ?? (await dummyPasswordHash()));
  if (!account || !account.passwordHash || !valid) throw new ApiError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  return startSession(request, { id: account.id, email: account.email });
}

/** Ends the current session (this device only) and clears the cookie. No session is already "signed out". */
export async function signOut(request: Request) {
  const store = await cookies();
  await deleteSession(db(), sessionTokenFrom(request.headers.get("authorization"), store.get(SESSION_COOKIE)?.value));
  store.delete(SESSION_COOKIE);
}

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(8).max(72),
});

/** The current request's session token (Bearer or cookie). */
async function currentToken(request: Request) {
  return sessionTokenFrom(request.headers.get("authorization"), (await cookies()).get(SESSION_COOKIE)?.value);
}

/**
 * Changes the signed-in account's password after checking the current one, and ends every OTHER session of
 * the account (this device stays signed in). Rate limited like sign-in.
 */
export async function changePassword(request: Request, userId: string, input: z.infer<typeof changePasswordSchema>) {
  await enforce([[`auth:password:user:${userId}`, LIMITS.signInPerIpAndEmail]]);
  const [account] = await db().select({ passwordHash: authUsers.passwordHash }).from(authUsers).where(eq(authUsers.id, userId)).limit(1);
  if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash)))
    throw new ApiError(403, "Current password is wrong", "WRONG_PASSWORD");
  if (input.currentPassword === input.newPassword) throw new ApiError(422, "The new password must differ", "SAME_PASSWORD");
  await db().update(authUsers).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(authUsers.id, userId));
  return signOutOtherSessions(request, userId);
}

/** Ends every session of the account except the one making this request. Returns how many were ended. */
export async function signOutOtherSessions(request: Request, userId: string) {
  const token = await currentToken(request);
  const keep = token ? createHash("sha256").update(token).digest("hex") : "";
  const ended = await db()
    .delete(authSessions)
    .where(and(eq(authSessions.userId, userId), ne(authSessions.tokenHash, keep)))
    .returning({ id: authSessions.id });
  return { endedSessions: ended.length };
}

/** Number of active sessions of the account (shown on the settings page). */
export async function activeSessionCount(userId: string) {
  const [r] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, sql`now()`)));
  return r?.n ?? 0;
}
