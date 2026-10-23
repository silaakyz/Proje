/**
 * requireOrgRole / requireOrgPermission on a real migrated PostgreSQL.
 * The membership lookup runs through the real withRls (role `authenticated`, JWT claims set), exactly
 * as getUserDb() runs it in production. Only obtaining the verified claims (session lookup) is
 * replaced: `signIn(user)` stands for "a valid session of this user", `signOut()` for "no session".
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withRls } from "@/db/rls";
import { userRole } from "@/db/schema";
import { AuthError } from "@/server/auth/errors";
import { ORG_A, ORG_B, U, setupDb } from "./helpers";

const h = vi.hoisted(() => ({ runner: null as null | (<T>(fn: (tx: never) => Promise<T>) => Promise<T>) }));
vi.mock("@/db", () => {
  class UnauthenticatedError extends Error {}
  return {
    UnauthenticatedError,
    getUserDb: async () => {
      if (!h.runner) throw new UnauthenticatedError("Not signed in");
      return h.runner;
    },
  };
});

const { requireOrgRole, requireOrgPermission, ORG_PERMISSIONS } = await import("@/server/auth/org-access");

const ADMIN_A = "a0000000-0000-4000-8000-0000000000ad";
let ctx: Awaited<ReturnType<typeof setupDb>>;

const signIn = (userId: string) => {
  h.runner = ((fn) => withRls(ctx.db, { sub: userId }, fn as never)) as typeof h.runner;
};
const signOut = () => {
  h.runner = null;
};
/** Resolves to "ok:<role>" or "<status> <message>". */
const attempt = async (p: Promise<{ role: string }>) => {
  try {
    return `ok:${(await p).role}`;
  } catch (e) {
    if (e instanceof AuthError) return `${e.status} ${e.message}`;
    throw e;
  }
};

beforeAll(async () => {
  ctx = await setupDb();
  await ctx.pg.query("insert into auth.users (id, email) values ($1, 'adminA@example.com')", [ADMIN_A]);
  await ctx.pg.query("insert into users (id, organization_id, email, role) values ($1, $2, 'adminA@example.com', 'admin')", [ADMIN_A, ORG_A]);
});
beforeEach(signOut);

describe("1–2. owner and admin may create and approve", () => {
  it.each([["owner", U.ownerA], ["admin", ADMIN_A]])("%s", async (role, id) => {
    signIn(id);
    for (const p of ["blueprint.generate", "proposal.decide", "org.read", "task.update_status", "event.write", "attendee.read"] as const)
      expect(await attempt(requireOrgPermission(ORG_A, p))).toBe(`ok:${role}`);
  });
  it("returns the verified context the services need", async () => {
    signIn(U.ownerA);
    expect(await requireOrgPermission(ORG_A, "blueprint.generate")).toEqual({
      userId: U.ownerA, organizationId: ORG_A, organizationName: "Org A", organizerType: "OTHER", role: "owner",
    });
  });
});

describe("3–4. staff: read and task status only", () => {
  it("may read and change task status", async () => {
    signIn(U.staffA);
    expect(await attempt(requireOrgPermission(ORG_A, "org.read"))).toBe("ok:staff");
    expect(await attempt(requireOrgPermission(ORG_A, "task.update_status"))).toBe("ok:staff");
  });
  it("is refused owner/admin operations with 403", async () => {
    signIn(U.staffA);
    expect(await attempt(requireOrgPermission(ORG_A, "blueprint.generate"))).toBe("403 Insufficient role");
    expect(await attempt(requireOrgPermission(ORG_A, "proposal.decide"))).toBe("403 Insufficient role");
    expect(await attempt(requireOrgPermission(ORG_A, "event.write"))).toBe("403 Insufficient role");
    expect(await attempt(requireOrgPermission(ORG_A, "attendee.read"))).toBe("403 Insufficient role");
    expect(await attempt(requireOrgRole(ORG_A, ["owner", "admin"]))).toBe("403 Insufficient role");
  });
});

describe("5. no cross-organization access", () => {
  it("an owner of A cannot act on B, and the reverse", async () => {
    signIn(U.ownerA);
    for (const p of Object.keys(ORG_PERMISSIONS) as (keyof typeof ORG_PERMISSIONS)[])
      expect(await attempt(requireOrgPermission(ORG_B, p))).toBe("403 Insufficient role");
    signIn(U.ownerB);
    expect(await attempt(requireOrgPermission(ORG_A, "org.read"))).toBe("403 Insufficient role");
    expect(await attempt(requireOrgPermission(ORG_B, "proposal.decide"))).toBe("ok:owner");
  });
  it("a malformed or unknown organization id is a 403, not an error", async () => {
    signIn(U.ownerA);
    expect(await attempt(requireOrgPermission("not-a-uuid", "org.read"))).toBe("403 Insufficient role");
    expect(await attempt(requireOrgPermission("ffffffff-ffff-4fff-8fff-ffffffffffff", "org.read"))).toBe("403 Insufficient role");
  });
});

describe("6. signed in but not a member", () => {
  it("a user without a membership row is refused everything", async () => {
    signIn(U.noProfile);
    for (const p of Object.keys(ORG_PERMISSIONS) as (keyof typeof ORG_PERMISSIONS)[])
      expect(await attempt(requireOrgPermission(ORG_A, p))).toBe("403 Insufficient role");
  });
  it("membership removed after sign-in takes effect on the next request", async () => {
    signIn(ADMIN_A);
    expect(await attempt(requireOrgPermission(ORG_A, "proposal.decide"))).toBe("ok:admin");
    await ctx.pg.query("delete from users where id = $1", [ADMIN_A]);
    expect(await attempt(requireOrgPermission(ORG_A, "proposal.decide"))).toBe("403 Insufficient role");
  });
});

describe("7. no session", () => {
  it("is a 401 for every permission, before any membership lookup", async () => {
    signOut();
    for (const p of Object.keys(ORG_PERMISSIONS) as (keyof typeof ORG_PERMISSIONS)[])
      expect(await attempt(requireOrgPermission(ORG_A, p))).toBe("401 Not signed in");
  });
});

describe("contract", () => {
  it("errors are the AuthError class that toErrorResponse maps to HTTP status", async () => {
    signIn(U.staffA);
    await expect(requireOrgPermission(ORG_A, "proposal.decide")).rejects.toBeInstanceOf(AuthError);
  });
  it("an empty role list is a programming error, not an open door", async () => {
    signIn(U.ownerA);
    await expect(requireOrgRole(ORG_A, [])).rejects.toThrow(/at least one role/);
  });
  it("the permission matrix uses exactly the roles the database knows", async () => {
    const used = new Set(Object.values(ORG_PERMISSIONS).flat());
    expect([...used].sort()).toEqual([...userRole.enumValues].sort());
    expect(ORG_PERMISSIONS).toEqual({
      "org.read": ["owner", "admin", "staff"],
      "task.update_status": ["owner", "admin", "staff"],
      "blueprint.generate": ["owner", "admin"],
      "proposal.decide": ["owner", "admin"],
      "event.write": ["owner", "admin"],
      "attendee.read": ["owner", "admin"],
      "attendee.write": ["owner", "admin"],
      "checkin.perform": ["owner", "admin", "staff"],
      "survey.manage": ["owner", "admin"],
      "survey.collect": ["owner", "admin", "staff"],
      "impact.manage": ["owner", "admin"],
      "member.manage": ["owner", "admin"],
      "org.manage": ["owner", "admin"],
      "budget.read": ["owner", "admin"],
      "budget.manage": ["owner", "admin"],
      "data.manage": ["owner", "admin"],
    });
  });
});
