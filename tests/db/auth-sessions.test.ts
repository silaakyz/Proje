/**
 * The PostgreSQL-only platform layer on a real database (PGlite + pgvector, scripts/db/bootstrap.sql, all
 * migrations): the bootstrap itself, accounts and sessions (src/server/auth/session.ts, src/db/sessions.ts)
 * and the rate limiter (src/server/rate-limit.ts). `@/db` is mocked so adminDb is the PGlite database and
 * next/headers so cookies can be inspected.
 */
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authSessions, authUsers } from "@/db/auth-schema";
import { createSession, deleteSession, findSessionUser } from "@/db/sessions";
import { outcome, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({
  db: null as unknown,
  cookies: new Map<string, { value: string; options?: Record<string, unknown> }>(),
  headers: {} as Record<string, string>,
}));
vi.mock("@/db", async () => {
  class UnauthenticatedError extends Error {}
  const adminDb = new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } });
  return { UnauthenticatedError, adminDb };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({
    get: (name: string) => (h.cookies.has(name) ? { name, value: h.cookies.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => void h.cookies.set(name, { value, options }),
    delete: (name: string) => void h.cookies.delete(name),
  }),
}));

const { signIn, signOut, signUp } = await import("@/server/auth/session");
const { hashPassword, verifyPassword } = await import("@/server/auth/password");
const { hitRateLimit } = await import("@/server/rate-limit");
const { ApiError } = await import("@/server/http");

let ctx: Awaited<ReturnType<typeof setupDb>>;
const db = () => ctx.db;
const req = (ip = "203.0.113.1", url = "http://localhost:3000/api/auth/sign-in", extra: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "x-forwarded-for": ip, "user-agent": "vitest", ...extra } });
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ApiError ? `${e.status} ${e.code}` : `unexpected: ${(e as Error).message}`;
  }
};
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`;

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
});
beforeEach(() => {
  h.cookies.clear();
  h.headers = {};
});

describe("bootstrap.sql", () => {
  it("is idempotent and does not undo 0006's default-privilege hardening when re-run", async () => {
    const acl = async () => (await ctx.pg.query("select defaclrole::regrole::text as r, defaclobjtype as t, defaclacl::text as acl from pg_default_acl order by 1, 2")).rows;
    const before = await acl();
    await ctx.pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
    await ctx.pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
    expect(await acl()).toEqual(before);
    expect((await ctx.pg.query("select count(*)::int as n from auth.users")).rows).toEqual([{ n: 4 }]);
  });

  it("keeps auth and rate-limit tables away from the RLS roles", async () => {
    for (const table of ["auth.users", "auth.sessions", "auth.password_resets", "app_private.rate_limits"]) {
      expect(await outcome(ctx.as(U.ownerA, (tx) => tx.execute(sql.raw(`select * from ${table}`))))).toMatch(/permission denied/);
    }
    // auth.uid() still works for the policies
    const res = (await ctx.as(U.ownerA, (tx) => tx.execute(sql`select auth.uid()::text as uid`))) as unknown as { rows: { uid: string }[] };
    expect(res.rows).toEqual([{ uid: U.ownerA }]);
  });
});

describe("passwords", () => {
  it("hash with a random salt and verify only the right password", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
    for (const broken of [null, "", "plain", "scrypt$1$8$1$AAAA$AAAA", "bcrypt$x"]) expect(await verifyPassword("x", broken)).toBe(false);
  });
});

describe("sessions", () => {
  it("a created session resolves to its user until it is deleted; only the token hash is stored", async () => {
    const { token } = await createSession(db(), U.ownerA, "vitest");
    expect(await findSessionUser(db(), token)).toEqual({ id: U.ownerA, email: "ownerA@example.com" });
    const stored = await db().select({ tokenHash: authSessions.tokenHash }).from(authSessions);
    expect(stored.some((s) => s.tokenHash === token)).toBe(false);
    await deleteSession(db(), token);
    expect(await findSessionUser(db(), token)).toBeNull();
  });

  it("expired, unknown and malformed tokens resolve to nobody", async () => {
    const { token } = await createSession(db(), U.staffA);
    await db().execute(sql`update auth.sessions set expires_at = now() - interval '1 second' where user_id = ${U.staffA}`);
    expect(await findSessionUser(db(), token)).toBeNull();
    expect(await findSessionUser(db(), "A".repeat(43))).toBeNull();
    expect(await findSessionUser(db(), "short")).toBeNull();
    expect(await findSessionUser(db(), null)).toBeNull();
  });
});

describe("sign-up, sign-in, sign-out", () => {
  const email = "New.User@Example.com";
  const password = "a-long-enough-password";

  it("sign-up creates the account, stores a hash (never the password) and starts a session", async () => {
    const res = await signUp(req(freshIp()), { email, password });
    expect(res).toMatchObject({ user: { email: "new.user@example.com" }, needsEmailConfirmation: false });
    expect(res.session.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.cookies.get("eip_session")).toMatchObject({ value: res.session.accessToken, options: { httpOnly: true, sameSite: "lax", secure: false, path: "/" } });
    const [row] = await db().select().from(authUsers).where(sql`email = 'new.user@example.com'`);
    expect(row?.passwordHash).toMatch(/^scrypt\$/);
    expect(row?.passwordHash).not.toContain(password);
    expect(await findSessionUser(db(), res.session.accessToken)).toMatchObject({ id: res.user.id });
  });

  it("the same address cannot sign up twice (case-insensitive)", async () => {
    expect(await codeOf(signUp(req(freshIp()), { email: "new.user@EXAMPLE.com", password }))).toBe("409 EMAIL_IN_USE");
  });

  it("sign-in accepts the right password in any letter case of the address; Secure cookie over HTTPS", async () => {
    const res = await signIn(req(freshIp(), "https://eip.example.test/api/auth/sign-in"), { email: "NEW.user@example.com", password });
    expect(h.cookies.get("eip_session")?.options).toMatchObject({ secure: true });
    expect(await findSessionUser(db(), res.session.accessToken)).toMatchObject({ email: "new.user@example.com" });
    const behindProxy = await signIn(req(freshIp(), "http://internal:3000/api/auth/sign-in", { "x-forwarded-proto": "https" }), { email, password });
    expect(behindProxy.session.accessToken).not.toBe(res.session.accessToken);
    expect(h.cookies.get("eip_session")?.options).toMatchObject({ secure: true });
  });

  it("wrong password and unknown address give the same 401", async () => {
    expect(await codeOf(signIn(req(freshIp()), { email, password: "wrong-password!" }))).toBe("401 INVALID_CREDENTIALS");
    expect(await codeOf(signIn(req(freshIp()), { email: "nobody@example.com", password }))).toBe("401 INVALID_CREDENTIALS");
    // accounts without a password (e.g. created by tests or imported) cannot sign in
    expect(await codeOf(signIn(req(freshIp()), { email: "ownerA@example.com", password }))).toBe("401 INVALID_CREDENTIALS");
  });

  it("sign-out ends the session everywhere it is used (cookie or Bearer) and clears the cookie", async () => {
    const res = await signIn(req(freshIp()), { email, password });
    await signOut(req(freshIp(), "http://localhost:3000/api/auth/sign-out", { authorization: `Bearer ${res.session.accessToken}` }));
    expect(await findSessionUser(db(), res.session.accessToken)).toBeNull();
    expect(h.cookies.has("eip_session")).toBe(false);
    // signing out without a session is fine
    await expect(signOut(req(freshIp()))).resolves.toBeUndefined();
  });

  it("repeated wrong passwords from one client are rate limited (429 before the password is checked)", async () => {
    const ip = freshIp();
    const results: string[] = [];
    for (let i = 0; i < 12; i++) results.push(await codeOf(signIn(req(ip), { email, password: "wrong-password!" })));
    expect(results.slice(0, 10).every((r) => r === "401 INVALID_CREDENTIALS")).toBe(true);
    expect(results.slice(10)).toEqual(["429 RATE_LIMITED", "429 RATE_LIMITED"]);
    // even the right password waits now; another client is unaffected
    expect(await codeOf(signIn(req(ip), { email, password }))).toBe("429 RATE_LIMITED");
    expect(await codeOf(signIn(req(freshIp()), { email, password }))).toBe("ok");
  });
});

describe("rate limiter", () => {
  const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

  it("allows `limit` hits per window and reports when to retry", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hitRateLimit("test:fixed", 3, { db: db(), now: T0 + 30_000 }));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]!.retryAfter).toBe(30);
  });

  it("weighs the previous window into the next one (sliding estimate)", async () => {
    for (let i = 0; i < 4; i++) await hitRateLimit("test:slide", 4, { db: db(), now: T0 + 50_000 });
    // 15 s into the next window: 4 × 0.75 + 1 = 4 → allowed; the next one is over.
    expect((await hitRateLimit("test:slide", 4, { db: db(), now: T0 + 75_000 })).ok).toBe(true);
    expect((await hitRateLimit("test:slide", 4, { db: db(), now: T0 + 75_000 })).ok).toBe(false);
    // two windows later the old hits no longer count
    expect((await hitRateLimit("test:slide", 4, { db: db(), now: T0 + 130_000 })).ok).toBe(true);
  });

  it("keys are independent", async () => {
    expect((await hitRateLimit("test:other", 1, { db: db(), now: T0 })).ok).toBe(true);
    expect((await hitRateLimit("test:other-2", 1, { db: db(), now: T0 })).ok).toBe(true);
    expect((await hitRateLimit("test:other", 1, { db: db(), now: T0 })).ok).toBe(false);
  });
});

describe("route error mapping", () => {
  it("a route that calls getUserDb() without a session answers 401, not 500", async () => {
    const { toErrorResponse } = await import("@/server/http");
    const { UnauthenticatedError } = await import("@/db");
    const res = toErrorResponse(new UnauthenticatedError("Not signed in"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in" });
  });
});
