/**
 * Team management: members of an organization, invitations, roles and organization settings.
 *
 * Server-only writes through adminDb, always AFTER the route checked the caller's permission
 * (requireOrgPermission → OrgAccess); every statement is additionally scoped to access.organizationId.
 *
 * Rules
 *  - Invitations: owner invites admin or staff, admin invites staff. A link carries a random token (only its
 *    sha256 is stored) and is valid for INVITATION_TTL_DAYS. Inviting an address that already has an open
 *    invitation replaces it (the old link stops working).
 *  - Accepting: the signed-in account's e-mail must equal the invited address, and the account must not yet
 *    belong to an organization (one account = one organization).
 *  - Roles: only an owner changes roles; there is always at least one owner.
 *  - Removing: an owner removes anyone, an admin removes staff, everyone may leave; never the last owner.
 *    A removed member keeps their account and can create or join another organization.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { authSessions } from "@/db/auth-schema";
import type { VerifiedClaims } from "@/db/rls";
import { organizationInvitations, organizations, users } from "@/db/schema";
import { ORGANIZER_TYPES } from "@/lib/domain/enums";
import type { OrgAccess, OrgRole } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";

export const INVITATION_TTL_DAYS = 7;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const normEmail = (e: string) => e.trim().toLowerCase();
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
};

export const inviteSchema = z.object({
  organizationId: z.uuid(),
  email: z.email().max(320),
  role: z.enum(["admin", "staff"]),
});
export const changeRoleSchema = z.object({ organizationId: z.uuid(), role: z.enum(["owner", "admin", "staff"]) });
export const updateOrganizationSchema = z
  .object({
    organizationId: z.uuid(),
    name: z.string().trim().min(2).max(120).optional(),
    organizerType: z.enum(ORGANIZER_TYPES).optional(),
  })
  .refine((v) => v.name !== undefined || v.organizerType !== undefined, { message: "Nothing to update" });

export interface Member {
  userId: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
  lastSignInAt: string | null;
  isSelf: boolean;
}

export async function listMembers(access: OrgAccess): Promise<Member[]> {
  const rows = await adminDb
    .select({
      userId: users.id,
      email: users.email,
      role: users.role,
      joinedAt: users.createdAt,
      lastSignInAt: sql<string | null>`(select a.last_sign_in_at from auth.users a where a.id = "users"."id")`,
    })
    .from(users)
    .where(eq(users.organizationId, access.organizationId))
    .orderBy(sql`case ${users.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(users.email));
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    role: r.role,
    joinedAt: r.joinedAt.toISOString(),
    lastSignInAt: r.lastSignInAt ? new Date(r.lastSignInAt).toISOString() : null,
    isSelf: r.userId === access.userId,
  }));
}

export interface InvitationSummary {
  id: string;
  email: string;
  role: "admin" | "staff";
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
}

const openInvitation = and(isNull(organizationInvitations.acceptedAt), isNull(organizationInvitations.revokedAt));

export async function listInvitations(access: OrgAccess): Promise<InvitationSummary[]> {
  const rows = await adminDb
    .select()
    .from(organizationInvitations)
    .where(and(eq(organizationInvitations.organizationId, access.organizationId), openInvitation, gt(organizationInvitations.expiresAt, sql`now()`)))
    .orderBy(desc(organizationInvitations.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role as "admin" | "staff",
    invitedByEmail: r.invitedByEmail,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/** Creates (or renews) an invitation. The token is returned once; only its hash is stored. */
export async function createInvitation(access: OrgAccess, input: z.infer<typeof inviteSchema>) {
  if (access.role === "admin" && input.role !== "staff") throw new ApiError(403, "Admins can invite staff only", "ROLE_NOT_ALLOWED");
  if (access.role === "staff") throw new ApiError(403, "Insufficient role");
  const email = normEmail(input.email);
  const [member] = await adminDb.select({ organizationId: users.organizationId }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (member) {
    throw member.organizationId === access.organizationId
      ? new ApiError(409, "This address is already a member", "ALREADY_IN_ORGANIZATION")
      : new ApiError(409, "This address already belongs to another organization", "MEMBER_OF_OTHER_ORGANIZATION");
  }
  const [inviter] = await adminDb.select({ email: users.email }).from(users).where(eq(users.id, access.userId)).limit(1);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const invitation = await adminDb.transaction(async (tx) => {
    await tx
      .update(organizationInvitations)
      .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(organizationInvitations.organizationId, access.organizationId), sql`lower(${organizationInvitations.email}) = ${email}`, openInvitation));
    const [row] = await tx
      .insert(organizationInvitations)
      .values({ organizationId: access.organizationId, email, role: input.role, tokenHash: hashToken(token), invitedByEmail: inviter?.email ?? null, expiresAt })
      .returning();
    return row!;
  });
  return {
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role as "admin" | "staff",
      invitedByEmail: invitation.invitedByEmail,
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
    } satisfies InvitationSummary,
    token,
  };
}

export async function revokeInvitation(access: OrgAccess, invitationId: string) {
  const rows = await adminDb
    .update(organizationInvitations)
    .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.organizationId, access.organizationId), openInvitation))
    .returning({ id: organizationInvitations.id });
  if (!rows[0]) throw new ApiError(404, "Invitation not found");
}

export type InvitationState = "open" | "expired" | "accepted" | "revoked";

async function findByToken(token: string) {
  if (!INVITE_TOKEN.test(token)) return null;
  const [row] = await adminDb
    .select({ inv: organizationInvitations, organizationName: organizations.name })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(eq(organizationInvitations.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return null;
  const { inv } = row;
  const state: InvitationState = inv.acceptedAt ? "accepted" : inv.revokedAt ? "revoked" : inv.expiresAt <= new Date() ? "expired" : "open";
  return { inv, organizationName: row.organizationName, state };
}

/** What the invitation page shows (public: whoever holds the link). */
export async function describeInvitation(token: string) {
  const found = await findByToken(token);
  if (!found) throw new ApiError(404, "Invitation not found", "INVITATION_NOT_FOUND");
  return {
    organizationName: found.organizationName,
    email: found.inv.email,
    role: found.inv.role as "admin" | "staff",
    state: found.state,
    expiresAt: found.inv.expiresAt.toISOString(),
  };
}

export async function acceptInvitation(claims: VerifiedClaims, token: string): Promise<OrgAccess> {
  const found = await findByToken(token);
  if (!found) throw new ApiError(404, "Invitation not found", "INVITATION_NOT_FOUND");
  if (found.state !== "open") throw new ApiError(410, `Invitation is ${found.state}`, `INVITATION_${found.state.toUpperCase()}`);
  const email = typeof claims.email === "string" ? normEmail(claims.email) : "";
  if (email !== normEmail(found.inv.email)) throw new ApiError(403, "This invitation is for another address", "INVITATION_EMAIL_MISMATCH");
  const [existing] = await adminDb.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, claims.sub)).limit(1);
  if (existing) throw new ApiError(409, "This user already belongs to an organization", "ALREADY_MEMBER");
  try {
    return await adminDb.transaction(async (tx) => {
      // Claim the invitation first: a concurrent accept or revoke makes this update hit no row.
      const claimed = await tx
        .update(organizationInvitations)
        .set({ acceptedAt: sql`now()`, acceptedBy: claims.sub, updatedAt: sql`now()` })
        .where(and(eq(organizationInvitations.id, found.inv.id), openInvitation, gt(organizationInvitations.expiresAt, sql`now()`)))
        .returning({ id: organizationInvitations.id });
      if (!claimed[0]) throw new ApiError(410, "Invitation is no longer open", "INVITATION_REVOKED");
      await tx.insert(users).values({ id: claims.sub, organizationId: found.inv.organizationId, email, role: found.inv.role });
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, found.inv.organizationId));
      return { userId: claims.sub, organizationId: org!.id, organizationName: org!.name, organizerType: org!.organizerType, role: found.inv.role };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError(409, "This user or email already has a profile", "ALREADY_MEMBER");
    throw e;
  }
}

async function memberOf(access: OrgAccess, userId: string) {
  const [m] = await adminDb
    .select({ userId: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, access.organizationId)))
    .limit(1);
  if (!m) throw new ApiError(404, "Member not found");
  return m;
}

async function otherOwners(access: OrgAccess, userId: string) {
  const [r] = await adminDb
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.organizationId, access.organizationId), eq(users.role, "owner"), ne(users.id, userId)));
  return r?.n ?? 0;
}

export async function changeMemberRole(access: OrgAccess, userId: string, role: OrgRole) {
  if (access.role !== "owner") throw new ApiError(403, "Only an owner can change roles", "ROLE_NOT_ALLOWED");
  const target = await memberOf(access, userId);
  if (target.role === role) return;
  if (target.role === "owner" && (await otherOwners(access, userId)) === 0)
    throw new ApiError(409, "The organization must keep at least one owner", "LAST_OWNER");
  await adminDb
    .update(users)
    .set({ role, updatedAt: sql`now()` })
    .where(and(eq(users.id, userId), eq(users.organizationId, access.organizationId)));
}

export async function removeMember(access: OrgAccess, userId: string) {
  const target = await memberOf(access, userId);
  const self = userId === access.userId;
  if (!self) {
    if (access.role === "staff") throw new ApiError(403, "Insufficient role");
    if (access.role === "admin" && target.role !== "staff") throw new ApiError(403, "Admins can remove staff only", "ROLE_NOT_ALLOWED");
  }
  if (target.role === "owner" && (await otherOwners(access, userId)) === 0)
    throw new ApiError(409, "The organization must keep at least one owner", "LAST_OWNER");
  await adminDb.transaction(async (tx) => {
    await tx.delete(users).where(and(eq(users.id, userId), eq(users.organizationId, access.organizationId)));
    // A removed member's open sessions stay valid for their account (they can join elsewhere), but they lose
    // every organization permission at once: memberships are looked up on each request.
    if (!self) await tx.delete(authSessions).where(eq(authSessions.userId, userId));
  });
}

export async function updateOrganization(access: OrgAccess, input: z.infer<typeof updateOrganizationSchema>) {
  const [org] = await adminDb
    .update(organizations)
    .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.organizerType ? { organizerType: input.organizerType } : {}), updatedAt: sql`now()` })
    .where(eq(organizations.id, access.organizationId))
    .returning({ id: organizations.id, name: organizations.name, organizerType: organizations.organizerType });
  return org!;
}
