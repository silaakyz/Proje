/**
 * Public survey rate limit (src/server/surveys/public-rate-limit.ts on src/server/rate-limit.ts). The database
 * is replaced by a stub whose counter query answers what each test needs; the counting itself runs on a
 * real PostgreSQL in tests/db/auth-sessions.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Counts = { current: number; previous: number };
const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn<() => Promise<Counts[]>>() }));

vi.mock("@/db", () => ({ adminDb: { execute: executeMock } }));

function request() {
  return new Request("https://example.test/api/public/surveys/test", {
    headers: { "x-forwarded-for": "198.51.100.7" },
  });
}

async function loadLimiter() {
  vi.resetModules();
  return import("../public-rate-limit");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  executeMock.mockReset();
  executeMock.mockResolvedValue([{ current: 1, previous: 0 }]);
  // no random pruning between the two counters: it would consume a mocked answer meant for the second one
  vi.spyOn(Math, "random").mockReturnValue(0.99);
});

afterEach(() => vi.restoreAllMocks());

describe("public survey rate limit", () => {
  it("allows a request within both limits and counts it per IP and per (link, IP)", async () => {
    const { limitPublicSurveyRequest } = await loadLimiter();
    const response = await limitPublicSurveyRequest(request(), "a-valid-test-survey-token", "read");

    expect(response).toBeNull();
    expect(executeMock).toHaveBeenCalledTimes(2); // one counter per IP, one per (link, IP)
  });

  it("returns 429 and Retry-After when a limit is exceeded", async () => {
    executeMock.mockResolvedValueOnce([{ current: 1, previous: 0 }]).mockResolvedValueOnce([{ current: 11, previous: 0 }]);

    const { limitPublicSurveyRequest } = await loadLimiter();
    const response = await limitPublicSurveyRequest(request(), "a-valid-test-survey-token", "submit");

    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await response?.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("counts the previous window's hits into the sliding estimate", async () => {
    // 20 submits per IP per minute: 15 in the previous window still weigh in at the start of the next one.
    executeMock.mockResolvedValueOnce([{ current: 10, previous: 15 }]).mockResolvedValue([{ current: 1, previous: 0 }]);
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 19, 10, 0, 1)); // 1 s into the window

    const { limitPublicSurveyRequest } = await loadLimiter();
    const response = await limitPublicSurveyRequest(request(), "a-valid-test-survey-token", "submit");
    vi.restoreAllMocks();

    expect(response?.status).toBe(429);
  });

  it("fails closed with 503 in production when the database does not answer", async () => {
    vi.stubEnv("NODE_ENV", "production");
    executeMock.mockRejectedValue(new Error("connection refused"));

    const { limitPublicSurveyRequest } = await loadLimiter();
    const response = await limitPublicSurveyRequest(request(), "a-valid-test-survey-token", "submit");

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
  });

  it("lets the request through in development when the database does not answer", async () => {
    executeMock.mockRejectedValue(new Error("connection refused"));

    const { limitPublicSurveyRequest } = await loadLimiter();
    expect(await limitPublicSurveyRequest(request(), "a-valid-test-survey-token", "read")).toBeNull();
  });
});
