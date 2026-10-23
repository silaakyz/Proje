/**
 * Rate limiting on PostgreSQL (table app_private.rate_limits, created by scripts/db/bootstrap.sql), shared by
 * every server instance that uses the same database — no separate Redis needed.
 *
 * Sliding-window estimate over fixed windows: hits in the current window plus the previous window's hits
 * weighted by how much of it still overlaps the sliding window. One atomic upsert per check. Requests that are
 * refused still count, so a client that keeps hammering stays refused. Old rows are pruned now and then.
 * Keys should not contain personal data in clear text: callers hash IPs and e-mail addresses (hashKey).
 */
import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { adminDb } from "@/db";
import type { AppDatabase } from "@/db/rls";

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the estimate falls below the limit again (only meaningful when !ok). */
  retryAfter: number;
}

export class RateLimitUnavailableError extends Error {}

const TIMEOUT_MS = 1_500;
const PRUNE_PROBABILITY = 0.01;

export const hashKey = (value: string) => createHash("sha256").update(value).digest("hex");

/** The client's IP as seen by the server (first X-Forwarded-For hop), hashed. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  return hashKey(forwarded?.split(",")[0]?.trim() || realIp?.trim() || "local-development");
}

/**
 * Counts one request for `key` and reports whether it is within `limit` per `windowSec`.
 * Throws RateLimitUnavailableError when the database does not answer in time or fails.
 */
export async function hitRateLimit(
  key: string,
  limit: number,
  { windowSec = 60, db = adminDb as unknown as AppDatabase, now = Date.now() }: { windowSec?: number; db?: AppDatabase; now?: number } = {},
): Promise<RateLimitResult> {
  const windowMs = windowSec * 1000;
  const start = Math.floor(now / windowMs) * windowMs;
  const elapsed = (now - start) / windowMs;
  const query = db.execute(sql`
    with cur as (
      insert into app_private.rate_limits as r (key, window_start, hits)
      values (${key}, to_timestamp(${start / 1000}), 1)
      on conflict (key, window_start) do update set hits = r.hits + 1
      returning hits
    )
    select (select hits from cur)::int as current,
      coalesce((select hits from app_private.rate_limits
                where key = ${key} and window_start = to_timestamp(${(start - windowMs) / 1000})), 0)::int as previous`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rows: unknown;
  try {
    rows = await Promise.race([
      query,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("rate limit query timed out")), TIMEOUT_MS))),
    ]);
  } catch (e) {
    throw new RateLimitUnavailableError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  // postgres-js returns the rows array, PGlite { rows }.
  const row = (Array.isArray(rows) ? rows[0] : (rows as { rows: unknown[] }).rows[0]) as { current: number; previous: number };
  const estimate = row.previous * (1 - elapsed) + row.current;

  if (Math.random() < PRUNE_PROBABILITY) {
    void db.execute(sql`delete from app_private.rate_limits where window_start < to_timestamp(${now / 1000}) - interval '1 hour'`).catch(() => {});
  }
  if (estimate <= limit) return { ok: true, retryAfter: 0 };
  // The previous window's weight shrinks linearly; when the current window alone is over, wait for it to end.
  const overByCurrent = row.current > limit;
  const retryAfter = overByCurrent
    ? Math.ceil((windowMs - (now - start)) / 1000)
    : Math.ceil(((estimate - limit) / Math.max(row.previous, 1)) * windowSec);
  return { ok: false, retryAfter: Math.max(1, retryAfter) };
}

/** 429 with Retry-After. */
export const tooManyRequests = (retryAfter: number) =>
  Response.json(
    { error: "Too many requests", code: "RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
  );

/** 503 when the limiter cannot decide (fail closed in production). */
export const rateLimitUnavailable = () =>
  Response.json(
    { error: "Rate limiting is unavailable", code: "RATE_LIMIT_UNAVAILABLE" },
    { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } },
  );
