/**
 * LIVE model test — calls the real Anthropic API. Skipped unless ANTHROPIC_API_KEY is set.
 *   ANTHROPIC_API_KEY=... npm run test:live
 * Asserts behaviour the product depends on, not exact wording.
 */
import { describe, expect, it } from "vitest";
import { generateText, Output } from "ai";
import { AI_TASKS, modelFor } from "@/server/ai/models";
import { blueprintCoreDraftSchema, normalizeBlueprintCore } from "@/lib/ai/blueprint/core";
import { buildCoreSystemPrompt } from "@/lib/ai/blueprint/prompts";
import { todayIstanbul } from "@/lib/time/istanbul";

const live = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!live)("live: Stage 1 core profile", () => {
  const today = todayIstanbul();
  const run = (prompt: string, organizationType: "MUNICIPALITY" | "UNIVERSITY" | "EVENT_AGENCY") =>
    generateText({
      model: modelFor("eventBuilder"),
      temperature: AI_TASKS.eventBuilder.temperature,
      maxOutputTokens: AI_TASKS.eventBuilder.maxOutputTokens,
      system: buildCoreSystemPrompt({ today, orgName: "Test", organizationType }),
      prompt,
      output: Output.object({ schema: blueprintCoreDraftSchema }),
    });

  it("does not invent dates, prices or venues; produces a valid, normalizable profile", async () => {
    const r = await run("İzmir'de 3 günlük, 500 kişilik bir teknoloji zirvesi düzenliyorum. Öğrenciler ücretsiz, kurumsal katılımcılar ücretli.", "UNIVERSITY");
    expect(r.output.event.startDate).toBeNull();
    expect(r.output.event.venueName).toBeNull();
    expect(r.output.event.format).toMatch(/SUMMIT|CONFERENCE/);
    const n = normalizeBlueprintCore(r.output, { today, organizationType: "UNIVERSITY" });
    expect(n.ok).toBe(true);
    if (n.ok) {
      expect(n.core.event.nuts2Code).toBe("TR31");
      expect(n.core.clarifications.some((c) => c.path === "event.startDate" && c.blocking)).toBe(true);
    }
  });

  it("records a client only when stated", async () => {
    const r = await run("Ajansımız Seyhan Belediyesi adına Adana'da 4 günlük bir sokak festivali organize ediyor.", "EVENT_AGENCY");
    expect(r.output.clientOrganizerType).toBe("MUNICIPALITY");
  });
});
