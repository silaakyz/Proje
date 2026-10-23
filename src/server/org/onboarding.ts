/**
 * First sign-in: a signed-in account (auth.users) without an app profile creates their organization and becomes its
 * owner. Server-side only (organizations/users are not browser-writable since 0006), via adminDb,
 * with the user id and email taken from the VERIFIED session claims — never from the request body.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import type { VerifiedClaims } from "@/db/rls";
import { organizations, users } from "@/db/schema";
import { ORGANIZER_TYPES } from "@/lib/domain/enums";
import { ApiError } from "@/server/http";
import type { OrgAccess } from "@/server/auth/org-access";

export const onboardingSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  organizerType: z.enum(ORGANIZER_TYPES).optional(),
});
export type OnboardingInput = z.infer<typeof onboardingSchema>;

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
};

export async function createOrganizationForUser(claims: VerifiedClaims, input: OnboardingInput): Promise<OrgAccess> {
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (!email) throw new ApiError(400, "The session has no email address", "NO_EMAIL");
  const [existing] = await adminDb.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, claims.sub)).limit(1);
  if (existing) throw new ApiError(409, "This user already belongs to an organization", "ALREADY_MEMBER", { organizationId: existing.organizationId });

  try {
    return await adminDb.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: input.organizationName, organizerType: input.organizerType ?? "OTHER" })
        .returning({ id: organizations.id, name: organizations.name, organizerType: organizations.organizerType });
      await tx.insert(users).values({ id: claims.sub, organizationId: org!.id, email, role: "owner" });
      return { userId: claims.sub, organizationId: org!.id, organizationName: org!.name, organizerType: org!.organizerType, role: "owner" as const };
    });
  } catch (e) {
    // a concurrent onboarding of the same user, or the email is already used by another profile
    if (isUniqueViolation(e)) throw new ApiError(409, "This user or email already has a profile", "ALREADY_MEMBER");
    throw e;
  }
}
