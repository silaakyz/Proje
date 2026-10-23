/**
 * Events for the organizer UI. Reads and browser-equivalent writes run under RLS as the caller
 * (getUserDb → withRls): the same rules the RLS policies give the `authenticated` role (owner/admin create and update
 * title/status/dates, members read their organization's events). The route checks the permission
 * first so the caller gets a clean 403 instead of an RLS error.
 * Aggregates on the detail view (counts only, no personal data) are read with adminDb, scoped to the
 * organization of the already-authorised caller.
 */
import "server-only";
import { and, asc, count, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { attendees, eventKpis, events, modulesRegistry, proposals, surveys, tasks } from "@/db/schema";
import type { UserDbRunner } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";

const isoDate = z.iso.date();
export const EVENT_STATUSES = ["draft", "live", "completed"] as const;

export const createEventSchema = z
  .object({
    organizationId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    startDate: isoDate.nullish(),
    endDate: isoDate.nullish(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, { message: "endDate must not be before startDate", path: ["endDate"] });

export const updateEventSchema = z
  .object({
    organizationId: z.uuid(),
    title: z.string().trim().min(1).max(200).optional(),
    status: z.enum(EVENT_STATUSES).optional(),
    startDate: isoDate.nullable().optional(),
    endDate: isoDate.nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.status !== undefined || v.startDate !== undefined || v.endDate !== undefined, { message: "Nothing to update" });

const summaryColumns = {
  id: events.id,
  title: events.title,
  status: events.status,
  startDate: events.startDate,
  endDate: events.endDate,
  fromBlueprint: sql<boolean>`${events.aiConfigVersion} is not null`,
  archivedAt: events.archivedAt,
  createdAt: events.createdAt,
  updatedAt: events.updatedAt,
};
export type EventSummary = { id: string; title: string; status: (typeof EVENT_STATUSES)[number]; startDate: string | null; endDate: string | null; fromBlueprint: boolean; archivedAt: Date | null; createdAt: Date; updatedAt: Date };

/** Database CHECK / RLS errors a valid-looking request can still hit → 422 / 403. */
function mapDbError(e: unknown): never {
  const code = (e as { code?: string; cause?: { code?: string; constraint_name?: string; constraint?: string } })?.cause?.code ?? (e as { code?: string })?.code;
  const constraint = (e as { cause?: { constraint_name?: string; constraint?: string } })?.cause?.constraint ?? (e as { cause?: { constraint_name?: string } })?.cause?.constraint_name;
  if (code === "23514") {
    const message = constraint === "events_live_needs_dates" ? "A live or completed event needs a start date"
      : constraint === "events_dates_ordered" ? "endDate must not be before startDate" : "The event violates a data rule";
    throw new ApiError(422, message, "INVALID_EVENT", constraint ? { constraint } : undefined);
  }
  if (code === "42501") throw new ApiError(403, "Insufficient role");
  throw e;
}

/** The organization's events; archived ones only when `archived` is true (then only those). */
export async function listEvents(
  runAsUser: UserDbRunner,
  organizationId: string,
  status?: (typeof EVENT_STATUSES)[number],
  archived = false,
): Promise<EventSummary[]> {
  return runAsUser((tx) =>
    tx
      .select(summaryColumns)
      .from(events)
      .where(and(
        eq(events.organizationId, organizationId),
        status ? eq(events.status, status) : undefined,
        archived ? isNotNull(events.archivedAt) : isNull(events.archivedAt),
      ))
      .orderBy(sql`${events.startDate} asc nulls last`, desc(events.createdAt)),
  ) as Promise<EventSummary[]>;
}

export async function createEvent(runAsUser: UserDbRunner, input: z.infer<typeof createEventSchema>): Promise<EventSummary> {
  try {
    const [row] = await runAsUser((tx) =>
      tx
        .insert(events)
        .values({ organizationId: input.organizationId, title: input.title, startDate: input.startDate ?? null, endDate: input.endDate ?? null })
        .returning(summaryColumns),
    );
    return row as EventSummary;
  } catch (e) {
    mapDbError(e);
  }
}

export async function updateEvent(runAsUser: UserDbRunner, eventId: string, input: z.infer<typeof updateEventSchema>): Promise<EventSummary> {
  const set: Partial<typeof events.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) set.title = input.title;
  if (input.status !== undefined) set.status = input.status;
  if (input.startDate !== undefined) set.startDate = input.startDate;
  if (input.endDate !== undefined) set.endDate = input.endDate;
  // The start date before the change, read as the caller (RLS): the plan re-flows from it below.
  const previousStart = input.startDate === undefined ? undefined
    : (await runAsUser((tx) => tx.select({ startDate: events.startDate }).from(events)
        .where(and(eq(events.id, eventId), eq(events.organizationId, input.organizationId))).limit(1)))[0]?.startDate ?? null;
  let rows: EventSummary[];
  try {
    rows = (await runAsUser((tx) =>
      tx.update(events).set(set).where(and(eq(events.id, eventId), eq(events.organizationId, input.organizationId))).returning(summaryColumns),
    )) as EventSummary[];
  } catch (e) {
    mapDbError(e);
  }
  if (!rows[0]) throw new ApiError(404, "Event not found");
  if (previousStart !== undefined && previousStart !== rows[0].startDate)
    await reflowTaskDueDates(input.organizationId, eventId, previousStart, rows[0].startDate);
  return rows[0];
}

/**
 * Moves the plan with the event: tasks that carry a relative due date (due_offset_days) get
 * start date + offset again. Only tasks whose due date still follows the old schedule (or has none) are
 * moved — a due date a person set, and completed tasks, stay as they are. Runs after the caller's own
 * event update succeeded under RLS (event.write); tasks.due_date is not browser-writable, so this is server code.
 */
export async function reflowTaskDueDates(organizationId: string, eventId: string, oldStart: string | null, newStart: string | null) {
  const moved = await adminDb
    .update(tasks)
    .set({ dueDate: newStart ? sql`${newStart}::date + ${tasks.dueOffsetDays}` : null, updatedAt: new Date() })
    .where(and(
      eq(tasks.organizationId, organizationId), eq(tasks.eventId, eventId), isNotNull(tasks.dueOffsetDays), ne(tasks.status, "DONE"),
      or(isNull(tasks.dueDate), oldStart ? eq(tasks.dueDate, sql`${oldStart}::date + ${tasks.dueOffsetDays}`) : undefined),
    ))
    .returning({ id: tasks.id });
  return moved.length;
}

export interface EventDetail extends EventSummary {
  profile: {
    format: unknown; city: unknown; nuts2Code: unknown; expectedAttendance: unknown;
    objectives: unknown[]; modules: unknown[]; audience: unknown;
  } | null;
  modules: { moduleType: string; configuration: Record<string, unknown> }[];
  counts: {
    tasks: Record<string, number>;
    kpis: number;
    surveys: number;
    pendingProposals: number;
    /** Valid tickets (voided ones excluded) and how many of them checked in; `cancelled` = voided tickets. */
    attendees: { total: number; checkedIn: number; cancelled: number };
  };
}

export async function getEventDetail(runAsUser: UserDbRunner, organizationId: string, eventId: string): Promise<EventDetail> {
  // visibility under RLS decides 404 (another tenant's event is indistinguishable from a missing one)
  const [row] = await runAsUser((tx) =>
    tx.select({ ...summaryColumns, aiConfig: events.aiConfig }).from(events).where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1),
  );
  if (!row) throw new ApiError(404, "Event not found");
  const { aiConfig, ...summary } = row as EventSummary & { aiConfig: Record<string, unknown> | null };

  const scope = <T extends { organizationId: unknown; eventId: unknown }>(t: T) =>
    and(eq(t.organizationId as never, organizationId), eq(t.eventId as never, eventId));
  const [moduleRows, taskRows, [kpi], [survey], [pending], [att]] = await Promise.all([
    adminDb.select({ moduleType: modulesRegistry.moduleType, configuration: modulesRegistry.configuration }).from(modulesRegistry).where(scope(modulesRegistry)).orderBy(asc(modulesRegistry.moduleType)),
    adminDb.select({ status: tasks.status, n: count() }).from(tasks).where(scope(tasks)).groupBy(tasks.status),
    adminDb.select({ n: count() }).from(eventKpis).where(scope(eventKpis)),
    adminDb.select({ n: count() }).from(surveys).where(scope(surveys)),
    adminDb.select({ n: count() }).from(proposals).where(and(scope(proposals), eq(proposals.status, "PENDING"))),
    adminDb.select({
      total: sql<number>`count(*) filter (where ${attendees.cancelledAt} is null)::int`,
      checkedIn: sql<number>`count(*) filter (where ${attendees.isCheckedIn})::int`,
      cancelled: sql<number>`count(*) filter (where ${attendees.cancelledAt} is not null)::int`,
    }).from(attendees).where(scope(attendees)),
  ]);

  const ev = (aiConfig?.event ?? null) as Record<string, unknown> | null;
  return {
    ...summary,
    profile: aiConfig
      ? {
          format: ev?.format ?? null, city: ev?.city ?? null, nuts2Code: ev?.nuts2Code ?? null, expectedAttendance: ev?.expectedAttendance ?? null,
          objectives: (aiConfig.objectives as unknown[]) ?? [], modules: (aiConfig.modules as unknown[]) ?? [], audience: aiConfig.audience ?? null,
        }
      : null,
    modules: moduleRows,
    counts: {
      tasks: Object.fromEntries(taskRows.map((t) => [t.status, Number(t.n)])),
      kpis: Number(kpi?.n ?? 0),
      surveys: Number(survey?.n ?? 0),
      pendingProposals: Number(pending?.n ?? 0),
      attendees: { total: Number(att?.total ?? 0), checkedIn: Number(att?.checkedIn ?? 0), cancelled: Number(att?.cancelled ?? 0) },
    },
  };
}
