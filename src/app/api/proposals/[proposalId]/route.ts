/**
 * POST /api/proposals/:proposalId — apply or reject an AI proposal card.
 * The organizer may untick operations; only the kept indexes are applied.
 */
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-access";
import { applyProposal, rejectProposal } from "@/server/planning/apply-proposal-drizzle";
import { toApiProposalStatus } from "@/server/planning/proposal-error";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("apply"), organizationId: z.uuid(), opIndexes: z.array(z.number().int().nonnegative()).max(500).optional() }),
  z.object({ action: z.literal("reject"), organizationId: z.uuid() }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ proposalId: string }> }): Promise<Response> {
  try {
    const { proposalId } = await params;
    if (!z.uuid().safeParse(proposalId).success) return Response.json({ error: "Bad id" }, { status: 400 });
    const body = bodySchema.parse(await req.json().catch(() => null));
    const org = await requireOrgPermission(body.organizationId, "proposal.decide");

    if (body.action === "reject") {
      await rejectProposal(proposalId, org.organizationId, org.userId);
      return Response.json({ status: toApiProposalStatus("REJECTED") });
    }
    const r = await applyProposal({ proposalId, organizationId: org.organizationId, actorId: org.userId, opIndexes: body.opIndexes });
    // Stored as APPROVED; the API keeps reporting "APPLIED".
    return Response.json({ status: toApiProposalStatus("APPROVED"), ...r });
  } catch (e) {
    return toErrorResponse(e);
  }
}
