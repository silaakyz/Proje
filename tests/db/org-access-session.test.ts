/**
 * Scenario 7 through the REAL session path: src/db/index.ts getUserDb() → getVerifiedClaims() reading the
 * request's Authorization header and session cookie. Requests without a usable token are refused before
 * the database is touched (DATABASE_URL points nowhere on purpose). Session lookups against a real
 * database are covered in tests/db/auth-sessions.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/unreachable";
  return { headers: {} as Record<string, string>, cookies: {} as Record<string, string> };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({ get: (name: string) => (name in h.cookies ? { name, value: h.cookies[name] } : undefined) }),
}));

const { requireOrgPermission, requireOrgRole } = await import("@/server/auth/org-access");
const { AuthError } = await import("@/server/auth/errors");

const ORG = "0a000000-0000-4000-8000-00000000000a";
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return "allowed";
  } catch (e) {
    return e instanceof AuthError ? `${e.status} ${e.message}` : `unexpected: ${(e as Error).message}`;
  }
};

describe("7. no authenticated session (real getUserDb)", () => {
  beforeEach(() => {
    h.headers = {};
    h.cookies = {};
  });
  it("no session cookie and no Bearer token → 401", async () => {
    expect(await status(requireOrgPermission(ORG, "org.read"))).toBe("401 Not signed in");
  });
  it("malformed session cookie → 401", async () => {
    h.cookies = { eip_session: "not-a-session-token" };
    expect(await status(requireOrgRole(ORG, ["owner"]))).toBe("401 Not signed in");
  });
  it("malformed Bearer token (e.g. an old JWT) → 401", async () => {
    h.headers = { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" };
    expect(await status(requireOrgPermission(ORG, "proposal.decide"))).toBe("401 Not signed in");
  });
});
