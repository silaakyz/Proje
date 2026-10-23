/**
 * GET /api/events/:eventId/checkins/stream?organizationId=… — live check-ins as Server-Sent Events
 * (checkin.perform). Use with `new EventSource(url)` (same-origin cookies carry the session).
 *
 *   event: summary   data: CheckInSummary            (first message, then whenever the counts change)
 *   event: checkin   data: { attendeeId, ticketType, checkedInAt }   (each new check-in)
 *   : ping                                           (keep-alive comment)
 *
 * The server polls the database (CHECKIN_STREAM_INTERVAL_MS, default 2 s) instead of relying on
 * a push channel (LISTEN/NOTIFY), so it needs no extra connection per viewer, no trigger and no migration.
 * A stream ends after CHECKIN_STREAM_MAX_MS (default 270 s, below the function limit); EventSource
 * reconnects by itself (`retry: 2000`) and the first `summary` re-synchronises the counts.
 * Counts are authoritative. The per-check-in feed looks back 5 s to catch check-ins committed out of
 * order; one committed more than 5 s late is still counted but not listed individually.
 */
import { requireOrgPermission } from "@/server/auth/org-access";
import { checkInSummary, recentCheckIns } from "@/server/logistics/checkin";
import { uuidParam, uuidSegment } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOOKBACK_MS = 5_000;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }): Promise<Response> {
  try {
    const eventId = await uuidSegment(params, "eventId");
    const organizationId = uuidParam(req, "organizationId");
    await requireOrgPermission(organizationId, "checkin.perform");
    const first = await checkInSummary(organizationId, eventId); // 404 before the stream starts
    const interval = num(process.env.CHECKIN_STREAM_INTERVAL_MS, 2000);
    const maxMs = num(process.env.CHECKIN_STREAM_MAX_MS, 270_000);
    const enc = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const write = (text: string) => { if (!closed) controller.enqueue(enc.encode(text)); };
        const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const stopAt = Date.now() + maxMs;
        const close = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } };
        req.signal.addEventListener("abort", close);

        write("retry: 2000\n\n");
        send("summary", first);
        // An attendee checks in once, so the attendee id identifies a feed item. The query looks back
        // LOOKBACK_MS before the newest item sent, which also picks up check-ins committed slightly out
        // of order; ids already sent are skipped.
        let cursor = first.lastCheckedInAt;
        const sent = new Set(first.recent.map((r) => r.attendeeId));
        let counts = `${first.total}/${first.checkedIn}`;
        let lastPing = Date.now();
        try {
          if (cursor) for (const c of await recentCheckIns(organizationId, eventId, new Date(cursor.getTime() - LOOKBACK_MS), 5000)) sent.add(c.attendeeId);
          while (!closed && Date.now() < stopAt) {
            await new Promise((r) => setTimeout(r, interval));
            if (closed) break;
            const since = cursor ? new Date(cursor.getTime() - LOOKBACK_MS) : null;
            const fresh = (await recentCheckIns(organizationId, eventId, since)).filter((c) => !sent.has(c.attendeeId));
            for (const c of fresh) {
              send("checkin", c);
              sent.add(c.attendeeId);
              if (!cursor || c.checkedInAt > cursor) cursor = c.checkedInAt;
            }
            // counts also change without a new check-in (tickets issued), so they are compared every tick
            const s = await checkInSummary(organizationId, eventId);
            if (`${s.total}/${s.checkedIn}` !== counts) { counts = `${s.total}/${s.checkedIn}`; send("summary", s); }
            else if (!fresh.length && Date.now() - lastPing >= 15_000) { write(": ping\n\n"); lastPing = Date.now(); }
          }
        } catch (e) {
          send("error", { message: "stream interrupted; reconnecting" });
          console.error("checkins/stream", e);
        }
        close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
