import "server-only";
/**
 * Deletes an organization and everything it owns (events and all event data, surveys and responses, registrations,
 * budget, impact runs, multiplier sets, invitations, member profiles) and, optionally, its members' sign-in accounts.
 * One transaction: all or nothing. Used by `npm run org:delete` (e.g. to remove the former demo organization).
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { adminDb } from "@/db";
import { authUsers } from "@/db/auth-schema";
import { events, impactCalculationRuns, organizations, users } from "@/db/schema";

export interface OrganizationFootprint { id: string; name: string; members: { id: string; email: string | null }[]; events: number }

/** Organizations with this exact name (case-insensitive), with what deleting each would remove. */
export async function findOrganizations(name: string): Promise<OrganizationFootprint[]> {
  const orgs = await adminDb.select({ id: organizations.id, name: organizations.name }).from(organizations)
    .where(sql`lower(${organizations.name}) = lower(${name.trim()})`);
  return Promise.all(orgs.map(async (o) => {
    const ids = (await adminDb.select({ id: users.id }).from(users).where(eq(users.organizationId, o.id))).map((u) => u.id);
    const emails = new Map(ids.length
      ? (await adminDb.select({ id: authUsers.id, email: authUsers.email }).from(authUsers).where(inArray(authUsers.id, ids))).map((a) => [a.id, a.email] as const)
      : []);
    const members = ids.map((id) => ({ id, email: emails.get(id) ?? null }));
    const [ev] = await adminDb.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.organizationId, o.id));
    return { ...o, members, events: ev?.n ?? 0 };
  }));
}

export async function deleteOrganization(organizationId: string, { deleteAccounts }: { deleteAccounts: boolean }) {
  return adminDb.transaction(async (tx) => {
    const members = (await tx.select({ id: users.id }).from(users).where(eq(users.organizationId, organizationId))).map((m) => m.id);
    // runs first: a run keeps its multiplier set (ON DELETE RESTRICT), which the organization cascade also removes
    await tx.delete(impactCalculationRuns).where(eq(impactCalculationRuns.organizationId, organizationId));
    const deletedEvents = await tx.delete(events).where(eq(events.organizationId, organizationId)).returning({ id: events.id });
    const [org] = await tx.delete(organizations).where(eq(organizations.id, organizationId)).returning({ id: organizations.id });
    let accounts = 0;
    if (deleteAccounts && members.length) {
      // only accounts that no longer belong to any organization (a profile is one organization per user)
      const still = (await tx.select({ id: users.id }).from(users).where(inArray(users.id, members))).map((u) => u.id);
      const gone = await tx.delete(authUsers)
        .where(still.length ? and(inArray(authUsers.id, members), notInArray(authUsers.id, still)) : inArray(authUsers.id, members))
        .returning({ id: authUsers.id });
      accounts = gone.length;
    }
    return { deleted: !!org, events: deletedEvents.length, members: members.length, accounts };
  });
}
