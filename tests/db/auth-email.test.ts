/**
 * Sign-up policy (SIGNUP_MODE), e-mail through Brevo (network stubbed), password reset by e-mail and invitation
 * e-mails — Route Handlers and services on a migrated database; next/headers mocked so cookies can be read.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authPasswordResets, authSessions, authUsers } from "@/db/auth-schema";
import { organizationInvitations } from "@/db/schema";
import { ORG_A, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown, user: null as string | null, cookies: new Map<string, string>() }));
vi.mock("@/db", async () => {
  const { withRls } = await import("@/db/rls");
  class UnauthenticatedError extends Error {}
  const claims = () => {
    if (!h.user) throw new UnauthenticatedError("Not signed in");
    return { sub: h.user, email: `${h.user}@example.com` };
  };
  return {
    UnauthenticatedError,
    getVerifiedClaims: async () => claims(),
    getUserDb: async () => { const c = claims(); return <T,>(fn: Parameters<typeof withRls<T>>[2]) => withRls(h.db as never, c, fn); },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
    set: (n: string, v: string) => void h.cookies.set(n, v),
    delete: (n: string) => void h.cookies.delete(n),
  }),
}));

const optionsRoute = await import("@/app/api/auth/options/route");
const signUpRoute = await import("@/app/api/auth/sign-up/route");
const signInRoute = await import("@/app/api/auth/sign-in/route");
const resetRoute = await import("@/app/api/auth/password-reset/route");
const confirmRoute = await import("@/app/api/auth/password-reset/confirm/route");
const onboardingRoute = await import("@/app/api/onboarding/route");
const invitationsRoute = await import("@/app/api/org/invitations/route");

let ctx: Awaited<ReturnType<typeof setupDb>>;
let ip = 0;
const post = (body: unknown, url = "http://localhost:3000/api") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ip}` }, body: JSON.stringify(body) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const KEY = "xkeysib-test-0123456789abcdef";
const mailer = () => {
  const calls: { url: string; headers: Record<string, string>; body: { sender: { email: string; name?: string }; to: { email: string }[]; subject: string; htmlContent: string } }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ messageId: "<x@relay>" }), { status: 201 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
};
const withEmail = () => {
  vi.stubEnv("BREVO_API_KEY", KEY);
  vi.stubEnv("EMAIL_FROM", "Adana Büyükşehir <bilgi@adana.test>");
  vi.stubEnv("APP_URL", "https://etkinlik.adana.test/");
};

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  h.user = null;
});

describe("sign-in page options", () => {
  it("open sign-up by default; password reset only with e-mail configured; links never from the Host header in production", async () => {
    expect((await json(await optionsRoute.GET(new Request("http://localhost:3000/api/auth/options")))).body).toEqual({ signUp: "open", passwordReset: false });
    withEmail();
    vi.stubEnv("SIGNUP_MODE", "invite");
    expect((await json(await optionsRoute.GET(new Request("http://localhost:3000/api/auth/options")))).body).toEqual({ signUp: "invite", passwordReset: true });
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect((await json(await optionsRoute.GET(new Request("https://evil.example/api/auth/options")))).body.passwordReset).toBe(false);
  });
});

describe("SIGNUP_MODE=invite", () => {
  it("only invited addresses can sign up, and new organizations are not created from the app", async () => {
    vi.stubEnv("SIGNUP_MODE", "invite");
    expect(await json(await signUpRoute.POST(post({ email: "yabanci@ornek.test", password: "uzun-sifre-1" })))).toMatchObject({ status: 403, body: { code: "SIGNUP_INVITE_ONLY" } });
    await ctx.db.insert(organizationInvitations).values({ organizationId: ORG_A, email: "Davetli@Ornek.test", role: "staff", tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await signUpRoute.POST(post({ email: "davetli@ornek.test", password: "uzun-sifre-1" }))).status).toBe(201);
    h.user = U.ownerB; // any signed-in account: onboarding is closed in this mode
    expect(await json(await onboardingRoute.POST(post({ organizationName: "Yeni Kurum" })))).toMatchObject({ status: 403, body: { code: "ORG_CREATION_CLOSED" } });
    vi.stubEnv("SIGNUP_MODE", "open");
    expect((await signUpRoute.POST(post({ email: "acik@ornek.test", password: "uzun-sifre-1" }))).status).toBe(201);
  });
});

describe("password reset by e-mail", () => {
  it("needs e-mail configured; the same answer for unknown addresses; the link carries the token in the fragment", async () => {
    expect(await json(await resetRoute.POST(post({ email: "acik@ornek.test" })))).toMatchObject({ status: 503, body: { code: "EMAIL_DISABLED" } });
    withEmail();
    const calls = mailer();
    expect((await resetRoute.POST(post({ email: "yok@ornek.test" }))).status).toBe(202);
    expect(calls).toHaveLength(0);
    expect((await resetRoute.POST(post({ email: "ACIK@ornek.test" }))).status).toBe(202);
    expect(calls).toHaveLength(1);
    const m = calls[0]!;
    expect(m.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(m.headers["api-key"]).toBe(KEY);
    expect(m.body).toMatchObject({ sender: { name: "Adana Büyükşehir", email: "bilgi@adana.test" }, to: [{ email: "acik@ornek.test" }], subject: "EIP — şifre sıfırlama" });
    expect(m.body).not.toHaveProperty("textContent"); // one body type per request
    const token = m.body.htmlContent.match(/https:\/\/etkinlik\.adana\.test\/sifre-yenile#([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();
    const rows = await ctx.db.select().from(authPasswordResets);
    expect(JSON.stringify(rows)).not.toContain(token!); // only the hash is stored
  });

  it("the link sets the password once, closes the other links and ends every session", async () => {
    withEmail();
    const calls = mailer();
    await resetRoute.POST(post({ email: "acik@ornek.test" }));
    const older = calls.at(-1)!.body.htmlContent.match(/#([A-Za-z0-9_-]{43})/)![1]!;
    await resetRoute.POST(post({ email: "acik@ornek.test" }));
    const token = calls.at(-1)!.body.htmlContent.match(/#([A-Za-z0-9_-]{43})/)![1]!;
    const [acc] = await ctx.db.select().from(authUsers).where(sql`lower(${authUsers.email}) = 'acik@ornek.test'`);
    await ctx.db.insert(authSessions).values({ userId: acc!.id, tokenHash: "s".repeat(64), expiresAt: new Date(Date.now() + 3_600_000) });
    expect(await json(await confirmRoute.POST(post({ token: older, password: "yeni-sifre-2" })))).toMatchObject({ status: 400, body: { code: "RESET_LINK_INVALID" } }); // replaced
    expect((await confirmRoute.POST(post({ token, password: "yeni-sifre-2" }))).status).toBe(200);
    expect(await ctx.db.select().from(authSessions).where(eq(authSessions.userId, acc!.id))).toHaveLength(0);
    expect((await confirmRoute.POST(post({ token, password: "baska-sifre-3" }))).status).toBe(400); // used up
    expect((await signInRoute.POST(post({ email: "acik@ornek.test", password: "uzun-sifre-1" }))).status).toBe(401);
    expect((await signInRoute.POST(post({ email: "acik@ornek.test", password: "yeni-sifre-2" }))).status).toBe(200);
    // an expired link does not work
    await resetRoute.POST(post({ email: "acik@ornek.test" }));
    const late = calls.at(-1)!.body.htmlContent.match(/#([A-Za-z0-9_-]{43})/)![1]!;
    await ctx.pg.query("update auth.password_resets set expires_at = now() - interval '1 minute' where used_at is null");
    expect((await confirmRoute.POST(post({ token: late, password: "yeni-sifre-4" }))).status).toBe(400);
  });

  it("is rate limited per address", async () => {
    withEmail();
    mailer();
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await resetRoute.POST(post({ email: "limit@ornek.test" }))).status);
    expect(codes).toEqual([202, 202, 202, 429]);
  });
});

describe("invitation e-mails", () => {
  it("with e-mail configured the invitation link is e-mailed; a Brevo error keeps the invitation and never shows the key", async () => {
    h.user = U.ownerA;
    const r0 = await json(await invitationsRoute.POST(post({ organizationId: ORG_A, email: "ekip1@ornek.test", role: "staff" })));
    expect(r0).toMatchObject({ status: 201, body: { emailed: false } });
    withEmail();
    const calls = mailer();
    const r1 = await json(await invitationsRoute.POST(post({ organizationId: ORG_A, email: "ekip2@ornek.test", role: "admin" })));
    expect(r1).toMatchObject({ status: 201, body: { emailed: true } });
    expect(calls[0]!.body.to).toEqual([{ email: "ekip2@ornek.test" }]);
    expect(calls[0]!.body.htmlContent).toContain(`https://etkinlik.adana.test/davet/${r1.body.token}`);
    expect(calls[0]!.body.htmlContent).toContain("yönetici");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"message":"Key ${KEY} not found"}`, { status: 401 })));
    const r2 = await json(await invitationsRoute.POST(post({ organizationId: ORG_A, email: "ekip3@ornek.test", role: "staff" })));
    expect(r2).toMatchObject({ status: 201, body: { emailed: false, emailError: expect.stringContaining("Brevo 401") } });
    expect(JSON.stringify(r2.body)).not.toContain(KEY);
  });
});
