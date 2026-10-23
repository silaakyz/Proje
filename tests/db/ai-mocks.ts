/**
 * Test doubles shared by the Blueprint pipeline and route tests.
 * - A mock language model for the REAL AI SDK (generateText / streamText + Output.object): the SDK still
 *   builds the JSON-schema request and parses/validates the response; only the provider is replaced.
 * - Fixtures: the core example embedded in the core prompt, and valid section outputs keyed by a
 *   marker that appears in each section's system prompt.
 */
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

export type Responder = (system: string) => string | Error;
export interface MockState {
  respond: Responder;
  calls: { temperature?: number; responseFormat?: { type: string; schema?: unknown }; system: string }[];
}

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } };

export function mockModel(state: MockState) {
  const systemOf = (opts: { prompt: { role: string; content: unknown }[] }) =>
    opts.prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doGenerate: async (opts) => {
      const system = systemOf(opts as never);
      state.calls.push({ ...(opts as object), system });
      const out = state.respond(system);
      if (out instanceof Error) throw out;
      return { content: [{ type: "text", text: out }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
    doStream: async (opts) => {
      const system = systemOf(opts as never);
      state.calls.push({ ...(opts as object), system });
      const out = state.respond(system);
      if (out instanceof Error) throw out;
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: out },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ] as never[]),
      };
    },
  });
}

export const TODAY = "2026-10-16";

export async function coreExample() {
  const { buildCoreSystemPrompt } = await import("@/lib/ai/blueprint/prompts");
  const sys = buildCoreSystemPrompt({ today: TODAY, orgName: "X", organizationType: "MUNICIPALITY" });
  const ex = JSON.parse(sys.split("<response>")[1]!.split("</response>")[0]!);
  ex.event.startDate = "2027-04-22";
  return ex;
}

/** Markers that occur in each section's system prompt → a valid model answer. */
export const VALID_SECTIONS: Record<string, unknown> = {
  "Produce the task plan": { assumptions: [], tasks: [
    { key: "permits", title: "Valilik izin başvurusu", description: null, workstream: "permits", board: "PLANNING", phase: "PLAN", priority: "CRITICAL",
      dueOffsetDays: -90, assigneeRole: "Proje yöneticisi", dependsOnKeys: [], stakeholderKind: "PUBLIC_AUTHORITY" }] },
  "Select KPIs": { kpis: [{ metricKey: "overall_satisfaction", objectiveIndex: 0, target: null, targetBasis: null, rationale: "Deneyim" }] },
  "Write survey drafts": { surveys: [{ audience: "ATTENDEE", title: "Festival anketi", intro: "Kısa anket.", extraQuestions: [] }] },
  "budget skeleton": { budgetLines: [], risks: [] },
  "Produce registration": { ticketTypes: [], formFields: [], clarifications: [], assumptions: [] },
};
export const UNSUPPORTED_MARKERS = ["budget skeleton", "Produce registration"];

export const respondWith = (overrides: Record<string, string | Error> = {}, core?: unknown): Responder => (system) => {
  for (const [marker, out] of Object.entries(overrides)) if (system.includes(marker)) return out;
  for (const [marker, out] of Object.entries(VALID_SECTIONS)) if (system.includes(marker)) return JSON.stringify(out);
  if (core !== undefined) return JSON.stringify(core); // anything else: the core / event-builder prompt
  return new Error(`no mock for prompt: ${system.slice(0, 80)}`);
};
