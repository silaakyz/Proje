/**
 * Attendees, QR entry tokens and door check-in.
 * Browser roles cannot write attendees and cannot read qr_uuid (0006), so registration, QR issuance and
 * check-in are server-only (adminDb) and every query is scoped to the organization the route has
 * authorised with requireOrgPermission. Listing runs under RLS (owner/admin; qr_uuid not selectable).
 *
 * The QR code encodes the attendee's qr_uuid as plain text. A scan is resolved only within the scanned
 * event of the caller's organization: a token of another event or tenant is "unknown" (404), never
 * distinguishable from a forged one.
 */
import "server-only";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { adminDb } from "@/db";
import { attendees, events } from "@/db/schema";
import type { UserDbRunner } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";

export const registerSchema = z.object({
  organizationId: z.uuid(),
  ticketType: z.string().trim().min(1).max(60),
  /** How many tickets of this type to issue at once (box office, bulk issue). */
  quantity: z.number().int().min(1).max(500).default(1),
});
export const cancelTicketsSchema = z.object({
  organizationId: z.uuid(),
  attendeeIds: z.array(z.uuid()).min(1).max(500).refine((ids) => new Set(ids).size === ids.length, "duplicate attendee ids"),
});
export const undoCheckInSchema = z.object({ organizationId: z.uuid(), attendeeId: z.uuid() });
export const checkInSchema = z.object({
  organizationId: z.uuid(),
  /**
   * The scanned QR content (the attendee's qr_uuid), or the short ticket number printed under the QR
   * ("EIP-" + the first 8 hex digits of the attendee id) typed in by hand at the door.
   */
  qrToken: z.string().trim().max(100),
});

/** Printed ticket number, e.g. EIP-7F3K2A9C (derived from the attendee id; shown to owner/admin in the ticket list). */
export const TICKET_CODE = /^EIP-([0-9A-F]{8})$/i;

/** Resolves a hand-typed ticket number to its QR token within one event; unknown or ambiguous → 404 / 409. */
async function qrTokenForCode(organizationId: string, eventId: string, code: string): Promise<string> {
  const prefix = TICKET_CODE.exec(code)![1]!.toLowerCase();
  const rows = await adminDb.select({ qrToken: attendees.qrUuid }).from(attendees)
    .where(and(eq(attendees.organizationId, organizationId), eq(attendees.eventId, eventId),
      sql`left(replace(${attendees.id}::text, '-', ''), 8) = ${prefix}`))
    .limit(2);
  if (rows.length === 0) throw new ApiError(404, "Unknown ticket", "UNKNOWN_TICKET");
  if (rows.length > 1) throw new ApiError(409, "Ticket number is ambiguous; scan the QR code", "AMBIGUOUS_TICKET_CODE");
  return rows[0]!.qrToken;
}

async function eventInOrg(organizationId: string, eventId: string) {
  const [ev] = await adminDb.select({ id: events.id, status: events.status, title: events.title })
    .from(events).where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  return ev;
}

export async function registerAttendees(eventId: string, input: z.infer<typeof registerSchema>) {
  const ev = await eventInOrg(input.organizationId, eventId);
  if (ev.status === "completed") throw new ApiError(409, "The event is completed", "EVENT_COMPLETED");
  const rows = await adminDb
    .insert(attendees)
    .values(Array.from({ length: input.quantity }, () => ({ organizationId: input.organizationId, eventId, ticketType: input.ticketType })))
    .returning({ id: attendees.id, ticketType: attendees.ticketType, qrToken: attendees.qrUuid, createdAt: attendees.createdAt });
  return rows;
}

/** Owner/admin list under RLS: qr_uuid is not selectable from the browser role, so it is not selected. */
export async function listAttendees(runAsUser: UserDbRunner, organizationId: string, eventId: string) {
  return runAsUser((tx) =>
    tx
      .select({ id: attendees.id, ticketType: attendees.ticketType, isCheckedIn: attendees.isCheckedIn, checkedInAt: attendees.checkedInAt,
        cancelledAt: attendees.cancelledAt, createdAt: attendees.createdAt })
      .from(attendees)
      .where(and(eq(attendees.organizationId, organizationId), eq(attendees.eventId, eventId)))
      .orderBy(asc(attendees.createdAt), asc(attendees.id))
      .limit(5000),
  );
}

export async function getQrToken(organizationId: string, eventId: string, attendeeId: string) {
  const [row] = await adminDb.select({ attendeeId: attendees.id, ticketType: attendees.ticketType, qrToken: attendees.qrUuid, cancelledAt: attendees.cancelledAt })
    .from(attendees)
    .where(and(eq(attendees.id, attendeeId), eq(attendees.eventId, eventId), eq(attendees.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new ApiError(404, "Attendee not found");
  return row;
}

export type CheckInResult = { status: "CHECKED_IN"; attendeeId: string; ticketType: string; checkedInAt: Date };

export async function checkIn(eventId: string, rawInput: z.infer<typeof checkInSchema>): Promise<CheckInResult> {
  const isCode = TICKET_CODE.test(rawInput.qrToken);
  if (!isCode && !z.uuid().safeParse(rawInput.qrToken).success) throw new ApiError(404, "Unknown ticket", "UNKNOWN_TICKET");
  const ev = await eventInOrg(rawInput.organizationId, eventId);
  if (ev.status === "completed") throw new ApiError(409, "The event is completed", "EVENT_COMPLETED");
  const input = isCode ? { ...rawInput, qrToken: await qrTokenForCode(rawInput.organizationId, eventId, rawInput.qrToken) } : rawInput;
  const scope = and(eq(attendees.qrUuid, input.qrToken), eq(attendees.eventId, eventId), eq(attendees.organizationId, input.organizationId));
  // one atomic statement: two scanners scanning the same ticket cannot both succeed
  const [done] = await adminDb.update(attendees)
    .set({ isCheckedIn: true, checkedInAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(scope, eq(attendees.isCheckedIn, false), isNull(attendees.cancelledAt)))
    .returning({ attendeeId: attendees.id, ticketType: attendees.ticketType, checkedInAt: attendees.checkedInAt });
  if (done) return { status: "CHECKED_IN", attendeeId: done.attendeeId, ticketType: done.ticketType, checkedInAt: done.checkedInAt! };
  const [seen] = await adminDb.select({ attendeeId: attendees.id, checkedInAt: attendees.checkedInAt, cancelledAt: attendees.cancelledAt })
    .from(attendees).where(scope).limit(1);
  if (!seen) throw new ApiError(404, "Unknown ticket", "UNKNOWN_TICKET");
  if (seen.cancelledAt) throw new ApiError(409, "This ticket was cancelled", "TICKET_CANCELLED", { attendeeId: seen.attendeeId, cancelledAt: seen.cancelledAt });
  throw new ApiError(409, "Already checked in", "ALREADY_CHECKED_IN", { attendeeId: seen.attendeeId, checkedInAt: seen.checkedInAt });
}

export interface CheckInSummary {
  eventId: string;
  total: number;
  checkedIn: number;
  byTicketType: { ticketType: string; total: number; checkedIn: number }[];
  recent: { attendeeId: string; ticketType: string; checkedInAt: Date }[];
  /** Cursor for the live feed: the latest check-in time included. */
  lastCheckedInAt: Date | null;
}

export async function checkInSummary(organizationId: string, eventId: string): Promise<CheckInSummary> {
  await eventInOrg(organizationId, eventId);
  const scope = and(eq(attendees.organizationId, organizationId), eq(attendees.eventId, eventId), isNull(attendees.cancelledAt));
  const [byType, recent] = await Promise.all([
    adminDb.select({ ticketType: attendees.ticketType, total: count(), checkedIn: sql<number>`count(*) filter (where ${attendees.isCheckedIn})::int` })
      .from(attendees).where(scope).groupBy(attendees.ticketType).orderBy(asc(attendees.ticketType)),
    recentCheckIns(organizationId, eventId, null, 20),
  ]);
  const types = byType.map((t) => ({ ticketType: t.ticketType, total: Number(t.total), checkedIn: Number(t.checkedIn) }));
  return {
    eventId,
    total: types.reduce((n, t) => n + t.total, 0),
    checkedIn: types.reduce((n, t) => n + t.checkedIn, 0),
    byTicketType: types,
    recent,
    lastCheckedInAt: recent[0]?.checkedInAt ?? null,
  };
}

/** Check-ins after `since` (oldest first when following a cursor; newest first for the initial list). */
export async function recentCheckIns(organizationId: string, eventId: string, since: Date | null, limit = 200) {
  const rows = await adminDb
    .select({ attendeeId: attendees.id, ticketType: attendees.ticketType, checkedInAt: attendees.checkedInAt })
    .from(attendees)
    .where(and(eq(attendees.organizationId, organizationId), eq(attendees.eventId, eventId), isNotNull(attendees.checkedInAt),
      since ? gt(attendees.checkedInAt, since) : undefined))
    .orderBy(since ? asc(attendees.checkedInAt) : desc(attendees.checkedInAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, checkedInAt: r.checkedInAt! }));
}

/**
 * Reverses a mistaken check-in (owner/admin). Atomic: only a checked-in, not cancelled ticket of this
 * event and organization is reset. 404 unknown attendee, 409 NOT_CHECKED_IN.
 */
export async function undoCheckIn(eventId: string, input: z.infer<typeof undoCheckInSchema>) {
  const ev = await eventInOrg(input.organizationId, eventId);
  if (ev.status === "completed") throw new ApiError(409, "The event is completed", "EVENT_COMPLETED");
  const scope = and(eq(attendees.id, input.attendeeId), eq(attendees.eventId, eventId), eq(attendees.organizationId, input.organizationId));
  const [row] = await adminDb.update(attendees)
    .set({ isCheckedIn: false, checkedInAt: null, updatedAt: sql`now()` })
    .where(and(scope, eq(attendees.isCheckedIn, true)))
    .returning({ attendeeId: attendees.id, ticketType: attendees.ticketType });
  if (row) return { status: "CHECK_IN_REVERSED" as const, ...row };
  const [seen] = await adminDb.select({ id: attendees.id }).from(attendees).where(scope).limit(1);
  if (!seen) throw new ApiError(404, "Attendee not found");
  throw new ApiError(409, "The ticket is not checked in", "NOT_CHECKED_IN");
}

/**
 * Voids tickets issued by mistake (owner/admin). A voided ticket cannot check in and is left out of every
 * count (check-in summary, event counts, impact attendance). A checked-in ticket is not voided (undo the
 * check-in first). Each id is reported in exactly one group; nothing outside this event/organization is touched.
 */
export async function cancelTickets(eventId: string, input: z.infer<typeof cancelTicketsSchema>) {
  const ev = await eventInOrg(input.organizationId, eventId);
  if (ev.status === "completed") throw new ApiError(409, "The event is completed", "EVENT_COMPLETED");
  const scope = and(eq(attendees.organizationId, input.organizationId), eq(attendees.eventId, eventId), inArray(attendees.id, input.attendeeIds));
  const cancelled = await adminDb.update(attendees)
    .set({ cancelledAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(scope, isNull(attendees.cancelledAt), eq(attendees.isCheckedIn, false)))
    .returning({ id: attendees.id });
  const rest = await adminDb.select({ id: attendees.id, isCheckedIn: attendees.isCheckedIn, cancelledAt: attendees.cancelledAt }).from(attendees).where(scope);
  const done = new Set(cancelled.map((r) => r.id));
  const found = new Map(rest.map((r) => [r.id, r]));
  return {
    cancelled: input.attendeeIds.filter((id) => done.has(id)),
    alreadyCancelled: input.attendeeIds.filter((id) => !done.has(id) && found.get(id)?.cancelledAt),
    checkedIn: input.attendeeIds.filter((id) => !done.has(id) && found.get(id)?.isCheckedIn),
    notFound: input.attendeeIds.filter((id) => !found.has(id)),
  };
}

/**
 * Printable tickets (owner/admin): each valid (not cancelled) ticket with its QR token and the QR code as
 * SVG markup (error correction M). `attendeeIds` limits the list; otherwise the event's first 500 tickets.
 */
export async function listTickets(organizationId: string, eventId: string, attendeeIds?: string[]) {
  await eventInOrg(organizationId, eventId);
  const rows = await adminDb
    .select({ attendeeId: attendees.id, ticketType: attendees.ticketType, qrToken: attendees.qrUuid, isCheckedIn: attendees.isCheckedIn })
    .from(attendees)
    .where(and(eq(attendees.organizationId, organizationId), eq(attendees.eventId, eventId), isNull(attendees.cancelledAt),
      attendeeIds ? inArray(attendees.id, attendeeIds) : undefined))
    .orderBy(asc(attendees.createdAt), asc(attendees.id))
    .limit(500);
  return Promise.all(rows.map(async (r) => ({ ...r, qrSvg: await qrSvg(r.qrToken) })));
}

/** The QR code of an entry token as standalone SVG (the scanner reads the token as plain text). */
export const qrSvg = (token: string) => QRCode.toString(token, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
