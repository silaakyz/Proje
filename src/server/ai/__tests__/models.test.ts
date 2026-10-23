import { beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("../models");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const k of ["AI_PROVIDER", "GOOGLE_GENERATIVE_AI_API_KEY", "ANTHROPIC_API_KEY", "AI_MODEL_EVENT_BUILDER", "AI_MODEL_ASSISTANT"]) vi.stubEnv(k, "");
});

describe("AI provider selection", () => {
  it("defaults to Gemini (free tier) and reports the missing key", async () => {
    const m = await load();
    expect(m.aiProvider()).toBe("google");
    expect(m.AI_TASKS.eventBuilder).toMatchObject({ provider: "google", modelId: "gemini-3.8-flash" });
    expect(m.AI_TASKS.assistant.modelId).toBe("gemini-3.5-flash-lite");
    expect(() => m.assertAiConfigured()).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
  });

  it("uses Claude when only an Anthropic key is set, or when AI_PROVIDER says so", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    let m = await load();
    expect(m.AI_TASKS.eventBuilder).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(() => m.assertAiConfigured()).not.toThrow();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "g-test");
    vi.stubEnv("AI_PROVIDER", "anthropic");
    m = await load();
    expect(m.aiProvider()).toBe("anthropic");
  });

  it("model ids can be pinned per task", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "g-test");
    vi.stubEnv("AI_MODEL_EVENT_BUILDER", "gemini-3.5-flash-lite");
    const m = await load();
    expect(m.AI_TASKS.eventBuilder.modelId).toBe("gemini-3.5-flash-lite");
    expect(m.modelFor("eventBuilder").modelId).toBe("gemini-3.5-flash-lite");
    expect(() => m.assertAiConfigured()).not.toThrow();
  });
});
