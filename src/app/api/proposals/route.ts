/**
 * GET /api/proposals?organizationId=…[&eventId=…|&eventId=none][&status=PENDING,APPLIED,…] — AI proposal
 * cards (org.read). eventId=none lists blueprint.core cards, which create their event when applied.
 * PENDING cards past their expiry are marked EXPIRED first.
 * Decide with POST /api/proposals/:proposalId.
 */
import { z } from "zod";
import { getUserDb } from "@/db";
import { requireOrgPermission } from "@/server/auth/org-access";
import { listProposals, PROPOSAL_API_STATUSES } from "@/server/ai/ai-read";
import { expireStaleProposals } from "@/server/planning/apply-proposal-drizzle";
import { uuidParam } from "@/server/http-params";
import { ApiError, toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const organizationId = uuidParam(req, "organizationId");
    const sp = new URL(req.url).searchParams;
    const rawEvent = sp.get("eventId");
    let eventId: string | null | undefined;
    if (rawEvent === "none") eventId = null;
    else if (rawEvent !== null) {
      if (!z.uuid().safeParse(rawEvent).success) throw new ApiError(400, "eventId must be a UUID or 'none'");
      eventId = rawEvent;
    }
    const statuses = sp.get("status")?.split(",").filter(Boolean);
    const parsed = z.array(z.enum(PROPOSAL_API_STATUSES)).safeParse(statuses ?? []);
    if (!parsed.success) throw new ApiError(400, `status must be one of ${PROPOSAL_API_STATUSES.join(", ")}`);
    await requireOrgPermission(organizationId, "org.read");
    await expireStaleProposals(organizationId); // a card past its expiry is listed as EXPIRED, not as appliable
    return Response.json({ proposals: await listProposals(await getUserDb(), organizationId, { eventId, statuses: parsed.data }) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
