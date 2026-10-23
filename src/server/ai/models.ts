import "server-only";
import { anthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { ApiError } from "@/server/http";

/**
 * One place that decides provider, model and sampling per task. Deterministic tasks run at temperature 0.
 *
 * Provider (AI_PROVIDER):
 *   "google"    — Gemini API (GOOGLE_GENERATIVE_AI_API_KEY from Google AI Studio). Has a free tier; Google uses
 *                 free-tier prompts and answers to improve its products, so the app never sends personal data
 *                 to the model (contexts are counts and the organizer's own event texts).
 *   "anthropic" — Claude (ANTHROPIC_API_KEY).
 *   unset       — whichever key is configured, Google first.
 * Model ids are env-driven (AI_MODEL_*) so they can be pinned per environment without a deploy.
 */
export type AiProvider = "google" | "anthropic";

export function aiProvider(): AiProvider {
  const explicit = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit === "google" || explicit === "anthropic") return explicit;
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) return "google";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  return "google";
}

const DEFAULTS: Record<AiProvider, { eventBuilder: string; impactNarrative: string; assistant: string; dataAnalysis: string; fallback: string }> = {
  // Free tier (2026): Flash for structured planning; Flash-Lite has a much larger daily quota for chat and is the
  // fallback when Flash is busy, out of quota or unavailable for the key.
  google: { eventBuilder: "gemini-3.8-flash", impactNarrative: "gemini-3.8-flash", assistant: "gemini-3.5-flash-lite", dataAnalysis: "gemini-3.8-flash", fallback: "gemini-3.5-flash-lite" },
  anthropic: { eventBuilder: "claude-sonnet-5-5", impactNarrative: "claude-opus-5-5", assistant: "claude-sonnet-5-5", dataAnalysis: "claude-sonnet-5-5", fallback: "claude-haiku-5-5" },
};

const provider = aiProvider();
const env = (name: string) => process.env[name]?.trim() || undefined;

export const AI_TASKS = {
  eventBuilder: {
    provider,
    modelId: env("AI_MODEL_EVENT_BUILDER") ?? DEFAULTS[provider].eventBuilder,
    temperature: 0,
    // Gemini 3 counts "thinking" tokens in this limit; too low a limit cuts the JSON plan in half.
    maxOutputTokens: 16_000,
  },
  impactNarrative: {
    provider,
    modelId: env("AI_MODEL_IMPACT_NARRATIVE") ?? DEFAULTS[provider].impactNarrative,
    temperature: 0,
    maxOutputTokens: 12_000,
  },
  /**
   * Uploaded tables: proposes what each column means (from column statistics, never raw rows) and writes an
   * interpretation of the computed figures.
   */
  dataAnalysis: {
    provider,
    modelId: env("AI_MODEL_DATA_ANALYSIS") ?? DEFAULTS[provider].dataAnalysis,
    temperature: 0,
    maxOutputTokens: 4_000,
  },
  /** Read-only workspace assistant: answers and report drafts from the event's recorded data. */
  assistant: {
    provider,
    modelId: env("AI_MODEL_ASSISTANT") ?? DEFAULTS[provider].assistant,
    temperature: 0.2,
    maxOutputTokens: 4_000,
  },
} as const;

export type AiTask = keyof typeof AI_TASKS;

/** Model tried once more when the main model fails (busy, quota, not available for the key, cut-off output). */
export const FALLBACK_MODEL_ID = env("AI_MODEL_FALLBACK") ?? DEFAULTS[provider].fallback;

/**
 * Provider options for structured (JSON) tasks. Gemini 3 models think before answering; for filling a schema a
 * low thinking level is enough and leaves the output budget to the answer. AI_THINKING_LEVEL overrides it
 * (minimal | low | medium | high). Not sent to the fallback, so a model without thinking settings still works.
 */
export function structuredProviderOptions(): { google: { thinkingConfig: { thinkingLevel: string } } } | undefined {
  if (provider !== "google") return undefined;
  const level = env("AI_THINKING_LEVEL")?.toLowerCase() ?? "low";
  if (!["minimal", "low", "medium", "high"].includes(level)) return undefined;
  return { google: { thinkingConfig: { thinkingLevel: level } } };
}

let google: ReturnType<typeof createGoogleGenerativeAI> | undefined;

export function modelFor(task: AiTask, opts: { fallback?: boolean } = {}) {
  const modelId = opts.fallback ? FALLBACK_MODEL_ID : AI_TASKS[task].modelId;
  if (provider === "anthropic") return anthropic(modelId);
  // GOOGLE_GENERATIVE_AI_BASE_URL only for tests against a local stand-in; the key is read from the env.
  google ??= createGoogleGenerativeAI({ baseURL: env("GOOGLE_GENERATIVE_AI_BASE_URL") });
  return google(modelId);
}

/** 503 AI_NOT_CONFIGURED before any work is queued when the selected provider's key is missing. */
export function assertAiConfigured() {
  const key = provider === "google" ? "GOOGLE_GENERATIVE_AI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[key]?.trim()) throw new ApiError(503, `AI provider is not configured (${key})`, "AI_NOT_CONFIGURED");
}
