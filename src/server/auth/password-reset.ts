/**
 * "Şifremi unuttum": a one-time link by e-mail (src/server/email/mailer.ts).
 *
 *  - request: always the same answer whether or not the address has an account (no account enumeration); rate limited
 *    per IP and per address; a new link replaces the address's open ones. Only the sha256 of the token is stored.
 *  - confirm: the token must be unused and unexpired (RESET_TTL_MINUTES); the password is set, the link is used up,
 *    every other link of the account is closed and every session of the account ends (sign in again).
 * The link carries the token in the URL fragment (/sifre-yenile#token), which browsers never send to a server.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { authPasswordResets, authSessions, authUsers } from "@/db/auth-schema";
import { hashPassword } from "@/server/auth/password";
import { appBaseUrl, emailAvailable, EmailError, passwordResetMail, sendMail, type MailFetch } from "@/server/email/mailer";
import { ApiError } from "@/server/http";
import { clientKey, hashKey, hitRateLimit, RateLimitUnavailableError } from "@/server/rate-limit";

export const RESET_TTL_MINUTES = 60;
const LIMITS = { perIp: 10, perEmail: 3 } as const;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export const resetRequestSchema = z.object({ email: z.email().max(320) });
export const resetConfirmSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().min(8).max(72) });

async function limit(key: string, n: number) {
  try {
    const r = await hitRateLimit(key, n);
    if (!r.ok) throw new ApiError(429, "Too many attempts, try again later", "RATE_LIMITED", { retryAfter: r.retryAfter });
  } catch (e) {
    if (!(e instanceof RateLimitUnavailableError)) throw e;
    if (process.env.NODE_ENV === "production") throw new ApiError(503, "Rate limiting is unavailable", "RATE_LIMIT_UNAVAILABLE");
  }
}

/** Sends a reset link if the address has an account. Resolves the same way either way. */
export async function requestPasswordReset(request: Request, input: z.infer<typeof resetRequestSchema>, fetchImpl?: MailFetch) {
  if (!emailAvailable(request)) throw new ApiError(503, "E-mail is not configured", "EMAIL_DISABLED");
  const email = input.email.trim().toLowerCase();
  await limit(`auth:reset:ip:${clientKey(request)}`, LIMITS.perIp);
  await limit(`auth:reset:email:${hashKey(email)}`, LIMITS.perEmail);
  const [account] = await adminDb.select({ id: authUsers.id, email: authUsers.email }).from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`).limit(1);
  if (!account?.email) return; // same answer as for a known address
  const token = randomBytes(32).toString("base64url");
  await adminDb.transaction(async (tx) => {
    await tx.update(authPasswordResets).set({ usedAt: sql`now()` })
      .where(and(eq(authPasswordResets.userId, account.id), isNull(authPasswordResets.usedAt)));
    await tx.insert(authPasswordResets).values({
      userId: account.id, tokenHash: sha(token), expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
    });
  });
  const url = `${appBaseUrl(request)}/sifre-yenile#${token}`;
  try {
    await sendMail(passwordResetMail({ to: account.email, url, minutes: RESET_TTL_MINUTES }), fetchImpl);
  } catch (e) {
    // the caller must not learn whether the address exists: log for the operator, answer as usual
    console.warn(`[email] şifre sıfırlama e-postası gönderilemedi: ${e instanceof EmailError ? e.message : "bilinmeyen hata"}`);
  }
}

export async function confirmPasswordReset(input: z.infer<typeof resetConfirmSchema>) {
  const passwordHash = await hashPassword(input.password);
  const ok = await adminDb.transaction(async (tx) => {
    const [reset] = await tx.update(authPasswordResets).set({ usedAt: sql`now()` })
      .where(and(eq(authPasswordResets.tokenHash, sha(input.token)), isNull(authPasswordResets.usedAt), gt(authPasswordResets.expiresAt, sql`now()`)))
      .returning({ userId: authPasswordResets.userId });
    if (!reset) return false;
    await tx.update(authUsers).set({ passwordHash }).where(eq(authUsers.id, reset.userId));
    await tx.update(authPasswordResets).set({ usedAt: sql`now()` })
      .where(and(eq(authPasswordResets.userId, reset.userId), isNull(authPasswordResets.usedAt)));
    await tx.delete(authSessions).where(eq(authSessions.userId, reset.userId));
    return true;
  });
  if (!ok) throw new ApiError(400, "This reset link is invalid or has expired", "RESET_LINK_INVALID");
}
