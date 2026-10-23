/**
 * Sign-in sessions stored in PostgreSQL (auth.sessions, see scripts/db/bootstrap.sql).
 *
 * A session token is 32 random bytes (base64url). The browser keeps it in the httpOnly cookie
 * SESSION_COOKIE; API clients send it as `Authorization: Bearer <token>`. The database stores only its
 * SHA-256, so a leaked database copy does not contain usable tokens. Signing out deletes the row, which
 * ends the session immediately everywhere it is used.
 *
 * Driver-agnostic (postgres-js in the app, PGlite in tests): every function takes the database.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { authSessions, authUsers } from "./auth-schema";
import type { AppDatabase } from "./rls";

export const SESSION_COOKIE = "eip_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export interface SessionUser {
  id: string;
  email: string | null;
}

export async function createSession(db: AppDatabase, userId: string, userAgent?: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db.insert(authSessions).values({ userId, tokenHash: hashToken(token), expiresAt, userAgent: userAgent?.slice(0, 300) ?? null });
  // Housekeeping: this user's expired sessions.
  await db.delete(authSessions).where(and(eq(authSessions.userId, userId), lt(authSessions.expiresAt, sql`now()`)));
  return { token, expiresAt };
}

/** The user of a valid, unexpired session token, or null. */
export async function findSessionUser(db: AppDatabase, token: string | null | undefined): Promise<SessionUser | null> {
  if (!token || !TOKEN_FORMAT.test(token)) return null;
  const rows = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authSessions)
    .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
    .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, sql`now()`)))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: AppDatabase, token: string | null | undefined) {
  if (!token || !TOKEN_FORMAT.test(token)) return;
  await db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
}

/** The session token of a request: Bearer header first (API clients), then the cookie (browsers). */
export function sessionTokenFrom(authorization: string | null | undefined, cookieValue: string | null | undefined) {
  return authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? cookieValue ?? null;
}
