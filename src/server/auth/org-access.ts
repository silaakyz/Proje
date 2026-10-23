/**
 * Application-layer authorization for the Drizzle data model (users.role: owner | admin | staff).
 *
 * This is the server-side gate every Route Handler / Server Action calls before doing work for an
 * organization. It does not replace RLS: RLS still decides which rows the caller can see, and the
 * membership lookup below itself runs under RLS (withRls via getUserDb), so it can only ever read the
 * caller's own users row. Server writes that bypass RLS (adminDb) must be preceded by this check.
 *
 */
import "server-only";
import { eq, sql } from "drizzle-orm";
import { getUserDb, UnauthenticatedError } from "@/db";
import type { AppTransaction } from "@/db/rls";
import { organizations, organizerType, userRole, users } from "@/db/schema";
// Same error class the existing routes use, so src/server/http.ts toErrorResponse maps it to 401/403 unchanged.
import { AuthError } from "@/server/auth/errors";

export type OrgRole = (typeof userRole.enumValues)[number];
export type OrganizerType = (typeof organizerType.enumValues)[number];

/**
 * What each role may do. Keep route code on permissions, not on raw role lists.
 *  - owner, admin: create (generate Blueprints) and approve/reject proposals
 *  - staff: read the organization's data and change a task's status
 *  - event.write, attendee.read: the same roles RLS allows for direct browser access since 0006
 *    (events/modules_registry INSERT/UPDATE; attendees SELECT). Kept equal to RLS_ROLES in
 *    src/db/schema.ts — parity-tested against the live policies (tests/db/access-hardening.test.ts).
 * Direct browser writes are governed separately by RLS + column grants (staff: tasks.status only).
 */
export const ORG_PERMISSIONS = {
  "org.read": ["owner", "admin", "staff"],
  "task.update_status": ["owner", "admin", "staff"],
  "blueprint.generate": ["owner", "admin"],
  "proposal.decide": ["owner", "admin"],
  "event.write": ["owner", "admin"],
  "attendee.read": ["owner", "admin"],
  // Server-only operations (no browser privilege; the routes use adminDb after this check):
  "attendee.write": ["owner", "admin"], // register attendees, read their QR entry token
  "checkin.perform": ["owner", "admin", "staff"], // scan a QR at the door, see the check-in counter
  // 0007: surveys and impact
  "survey.manage": ["owner", "admin"], // open/close surveys, see the public link, read and exclude responses (= RLS_ROLES.surveyResponseRead)
  "survey.collect": ["owner", "admin", "staff"], // type in a respondent's answers (paper / interviewer surveys)
  "impact.manage": ["owner", "admin"], // record assumptions and multiplier sets, run and store impact calculations
  // 0009: team and organization settings (finer rules — who may invite/remove whom — in src/server/org/team-service.ts)
  "member.manage": ["owner", "admin"], // invite members, revoke invitations, change roles (owner only), remove members
  "org.manage": ["owner", "admin"], // edit the organization's name and organizer type
  // 0012: budget and finance (amounts are confidential: staff sees neither lines nor finance metrics)
  "budget.read": ["owner", "admin"], // read budget lines and the finance metrics computed from them (= RLS_ROLES.budgetRead)
  "budget.manage": ["owner", "admin"], // add, edit and delete budget lines
  // 0013: external data sources (credentials stay in the server environment)
  "data.manage": ["owner", "admin"], // configure and pull sources, review press mentions, upload sponsor / lead lists
} as const satisfies Record<string, readonly OrgRole[]>;
export type OrgPermission = keyof typeof ORG_PERMISSIONS;

/** Verified caller + organization. Same fields as the legacy OrgContext so services can switch without changes. */
export interface OrgAccess {
  userId: string;
  organizationId: string;
  organizationName: string;
  organizerType: OrganizerType;
  role: OrgRole;
}

/** Runs a callback in one transaction as the verified caller under RLS (what getUserDb() returns). */
export type UserDbRunner = <T>(fn: (tx: AppTransaction) => Promise<T>) => Promise<T>;

/** Permissions the given role holds (what the frontend may offer to this user). */
export const permissionsFor = (role: OrgRole): OrgPermission[] =>
  (Object.keys(ORG_PERMISSIONS) as OrgPermission[]).filter((p) => (ORG_PERMISSIONS[p] as readonly OrgRole[]).includes(role));

/** The caller's own membership (under RLS: only their own users row is readable), or null without a profile. */
export async function findOwnMembership(runAsUser: UserDbRunner): Promise<OrgAccess | null> {
  const rows = await runAsUser((tx) =>
    tx
      .select({
        userId: users.id,
        organizationId: users.organizationId,
        role: users.role,
        organizationName: organizations.name,
        organizerType: organizations.organizerType,
      })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(eq(users.id, sql`(select auth.uid())`))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Core check, given a runner already bound to the verified caller.
 * Identity comes from the JWT inside the database (auth.uid()), never from request input; the
 * requested organizationId is only compared against the caller's own membership.
 */
export async function resolveOrgAccess(
  runAsUser: UserDbRunner,
  organizationId: string,
  allowed: readonly OrgRole[],
): Promise<OrgAccess> {
  if (allowed.length === 0) throw new Error("requireOrgRole: at least one role must be allowed");

  const member = await findOwnMembership(runAsUser);

  // Same response as the legacy helper for every denial, so callers cannot probe which organizations exist.
  if (!member || member.organizationId !== organizationId || !allowed.includes(member.role)) {
    throw new AuthError(403, "Insufficient role");
  }
  return member;
}

/** Requires a signed-in member of `organizationId` whose role is in `allowed`. 401 / 403 as AuthError. */
export async function requireOrgRole(organizationId: string, allowed: readonly OrgRole[]): Promise<OrgAccess> {
  let runAsUser: UserDbRunner;
  try {
    runAsUser = await getUserDb();
  } catch (e) {
    if (e instanceof UnauthenticatedError) throw new AuthError(401, "Not signed in");
    throw e;
  }
  return resolveOrgAccess(runAsUser, organizationId, allowed);
}

/** Whether a role holds a permission (for data a route shows only to some of the roles it admits). */
export const roleHas = (role: OrgRole, permission: OrgPermission) => (ORG_PERMISSIONS[permission] as readonly OrgRole[]).includes(role);

/** Preferred entry point for routes: `await requireOrgPermission(orgId, "proposal.decide")`. */
export function requireOrgPermission(organizationId: string, permission: OrgPermission): Promise<OrgAccess> {
  return requireOrgRole(organizationId, ORG_PERMISSIONS[permission]);
}
