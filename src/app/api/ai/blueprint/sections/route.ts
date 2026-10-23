/**
 * POST /api/ai/blueprint/sections — Stage 2.
 * Requires an applied event profile. Returns 202 immediately; each section lands as its own
 * proposal card (public.proposals).
 * `registration` and `budget_risks` are not supported yet (no tables for their operations): they are
 * never generated, a default run lists them as "unsupported", and naming them explicitly is a 422.
 */
import { after } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/db";
import { events } from "@/db/schema";
import { requireOrgPermission } from "@/server/auth/org-access";
import {
  ALL_BLUEPRINT_SECTIONS,
  SUPPORTED_SECTIONS,
  UNSUPPORTED_SECTIONS,
  assertSectionsSupported,
  runBlueprintSections,
} from "@/server/ai/blueprint-drizzle";
import { assertAiConfigured } from "@/server/ai/models";
import { toErrorResponse } from "@/server/http";
import { todayIstanbul } from "@/lib/time/istanbul";

export const runtime = "nodejs";
export const maxDuration = 300;

const bodySchema = z.object({
  organizationId: z.uuid(),
  eventId: z.uuid(),
  /** Regenerate selected sections only, e.g. ["tasks"]. Omit for all. */
  sections: z.array(z.enum(ALL_BLUEPRINT_SECTIONS)).min(1).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const body = bodySchema.parse(await req.json().catch(() => null));
    const org = await requireOrgPermission(body.organizationId, "blueprint.generate");
    assertAiConfigured();
    if (body.sections) assertSectionsSupported(body.sections); // 422, nothing queued
    const [event] = await adminDb
      .select({ id: events.id, aiConfigVersion: events.aiConfigVersion })
      .from(events)
      .where(and(eq(events.id, body.eventId), eq(events.organizationId, org.organizationId)))
      .limit(1);
    if (!event) return Response.json({ error: "Event not found" }, { status: 404 });
    if (!event.aiConfigVersion?.startsWith("blueprint/"))
      return Response.json({ error: "Event was not created from a Blueprint" }, { status: 409 });

    after(() => runBlueprintSections({ org, eventId: event.id, today: todayIstanbul() }, body.sections).then(() => undefined));
    const sections: Record<string, "queued" | "unsupported"> = Object.fromEntries((body.sections ?? SUPPORTED_SECTIONS).map((s) => [s, "queued"]));
    if (!body.sections) for (const s of UNSUPPORTED_SECTIONS) sections[s] = "unsupported";
    return Response.json({ status: "queued", eventId: event.id, sections }, { status: 202 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
