/**
 * Who may create an account and an organization.
 *
 *   SIGNUP_MODE=open    (default) anyone can sign up on the sign-in page and set up their own organization.
 *   SIGNUP_MODE=invite  sign-up only for an address with an open invitation; new organizations are created only by
 *                       an administrator (`npm run admin:create`). Recommended for a production installation.
 */
import "server-only";
import { sql } from "drizzle-orm";
import { adminDb } from "@/db";
import { organizationInvitations } from "@/db/schema";

export type SignupMode = "open" | "invite";

export function signupMode(): SignupMode {
  return process.env.SIGNUP_MODE?.trim().toLowerCase() === "invite" ? "invite" : "open";
}

export async function hasOpenInvitation(email: string) {
  const [row] = await adminDb.select({ id: organizationInvitations.id }).from(organizationInvitations)
    .where(sql`lower(${organizationInvitations.email}) = ${email.trim().toLowerCase()} and ${organizationInvitations.acceptedAt} is null
      and ${organizationInvitations.revokedAt} is null and ${organizationInvitations.expiresAt} > now()`)
    .limit(1);
  return !!row;
}
