/**
 * GET /api/health — public liveness/readiness probe for the container and the reverse proxy: 200 { ok: true } when
 * the database answers, 503 { ok: false } otherwise. Reveals nothing else (no version, no error text).
 */
import { sql } from "drizzle-orm";
import { adminDb } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await Promise.race([
      adminDb.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
