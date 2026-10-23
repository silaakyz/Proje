import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyAiError, scrubSecrets } from "../failures";

const apiError = (statusCode: number, responseBody: string) =>
  new APICallError({ message: "call failed", url: "https://generativelanguage.googleapis.com/v1beta/models/x?key=AIzaSyABCDEFGHIJKLMNOP", requestBodyValues: {}, statusCode, responseBody, isRetryable: statusCode >= 500 });

describe("AI failure classification", () => {
  it("reads the HTTP status of the provider (also behind the SDK's retry wrapper)", () => {
    expect(classifyAiError(apiError(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}')).kind).toBe("quota");
    expect(classifyAiError(apiError(503, '{"error":{"status":"UNAVAILABLE"}}')).kind).toBe("overloaded");
    expect(classifyAiError(apiError(404, '{"error":{"message":"models/gemini-x is not found for API version v1beta"}}')).kind).toBe("model_not_found");
    expect(classifyAiError(apiError(400, '{"error":{"message":"API key not valid"}}'))).toMatchObject({ kind: "auth", retryWithFallback: false });
    expect(classifyAiError(apiError(400, '{"error":{"status":"INVALID_ARGUMENT"}}'))).toMatchObject({ kind: "invalid_request", retryWithFallback: true });
    const wrapped = new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [apiError(503, "overloaded")] });
    expect(classifyAiError(wrapped).kind).toBe("overloaded");
    expect(classifyAiError(new Error("fetch failed")).kind).toBe("network");
    expect(classifyAiError(new Error("No output generated. finishReason: length")).kind).toBe("truncated");
  });

  it("never keeps credentials in the message", () => {
    expect(scrubSecrets("https://x/v1?key=AIzaSyABCDEFGHIJKLMNOP&alt=sse")).toBe("https://x/v1?key=[anahtar]&alt=sse");
    expect(scrubSecrets("bad key sk-ant-api03-abcDEF_123")).toBe("bad key [anahtar]");
    expect(classifyAiError(new Error("API key not valid: AIzaSyABCDEFGHIJKLMNOP")).message).not.toContain("AIza");
  });
});
