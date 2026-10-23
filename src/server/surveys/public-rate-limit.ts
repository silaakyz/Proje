/**
 * Rate limit for the public survey link (no session): per client IP and per (link, IP), sliding window of
 * 60 s, kept in PostgreSQL (src/server/rate-limit.ts) and therefore shared across server instances.
 *
 *  - A request over either limit gets 429 with Retry-After.
 *  - Database unreachable or slow (timeout): 503 in production (fail closed), allowed in development/test.
 * The client IP is hashed before it is used as a key; nothing is stored about the respondent.
 */
import "server-only";
import { clientKey, hashKey, hitRateLimit, rateLimitUnavailable, tooManyRequests } from "@/server/rate-limit";

type Action = "read" | "submit";

const LIMITS = {
  read: { perIp: 120, perLinkAndIp: 60 },
  submit: { perIp: 20, perLinkAndIp: 10 },
} as const;

const isProduction = () => process.env.NODE_ENV === "production";

/** null = go ahead; otherwise the response to return (429 or 503). */
export async function limitPublicSurveyRequest(request: Request, token: string, action: Action): Promise<Response | null> {
  const ip = clientKey(request);
  let results;
  try {
    results = [
      await hitRateLimit(`survey:${action}:ip:${ip}`, LIMITS[action].perIp),
      await hitRateLimit(`survey:${action}:link:${hashKey(`${token}\0${ip}`)}`, LIMITS[action].perLinkAndIp),
    ];
  } catch {
    return isProduction() ? rateLimitUnavailable() : null;
  }
  const rejected = results.filter((r) => !r.ok);
  if (rejected.length === 0) return null;
  return tooManyRequests(Math.max(...rejected.map((r) => r.retryAfter)));
}
