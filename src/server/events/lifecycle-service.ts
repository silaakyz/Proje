/**
 * Event lifecycle beyond create/update: archiving, duplicating and the attendee CSV export.
 * Server-only writes through adminDb after the route checked event.write / attendee.read; every statement is
 * scoped to the caller's organization. Events are archived, not deleted: impact runs and survey responses
 * are records that must stay (0007), and archiving keeps every reference intact.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { attendees, eventKpis, events, modulesRegistry, surveyQuestions, surveys, tasks } from "@/db/schema";
import type { OrgAccess } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";

const isoDate = z.iso.date();

export const archiveSchema = z.object({ organizationId: z.uuid(), archived: z.boolean() });
export const duplicateSchema = z.object({
  organizationId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
});

async function eventOf(access: OrgAccess, eventId: string) {
  const [ev] = await adminDb
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.organizationId, access.organizationId)))
    .limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  return ev;
}

export async function setEventArchived(access: OrgAccess, eventId: string, archived: boolean) {
  await eventOf(access, eventId);
  const [row] = await adminDb
    .update(events)
    .set({ archivedAt: archived ? sql`coalesce(${events.archivedAt}, now())` : null, updatedAt: sql`now()` })
    .where(and(eq(events.id, eventId), eq(events.organizationId, access.organizationId)))
    .returning({ id: events.id, archivedAt: events.archivedAt });
  return row!;
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Copies an event as a new DRAFT: its profile (ai_config), modules, plan (tasks: open again, due dates
 * recomputed from the new start date), KPIs (targets kept, actuals cleared) and surveys (as drafts without a
 * public link). Tickets, check-ins, responses, impact inputs and runs belong to the original and are not copied.
 */
export async function duplicateEvent(access: OrgAccess, eventId: string, input: z.infer<typeof duplicateSchema>) {
  const src = await eventOf(access, eventId);
  const startDate = input.startDate === undefined ? src.startDate : input.startDate;
  const endDate = input.endDate === undefined ? (input.startDate === undefined ? src.endDate : null) : input.endDate;
  if (startDate && endDate && endDate < startDate) throw new ApiError(422, "endDate is before startDate", "DATES_UNORDERED");
  const org = access.organizationId;

  return adminDb.transaction(async (tx) => {
    const [ev] = await tx
      .insert(events)
      .values({
        organizationId: org,
        title: input.title ?? `${src.title} (kopya)`,
        status: "draft",
        startDate,
        endDate,
        aiConfig: src.aiConfig,
        aiConfigVersion: src.aiConfigVersion,
      })
      .returning({ id: events.id, title: events.title });
    const newId = ev!.id;

    const mods = await tx.select().from(modulesRegistry).where(and(eq(modulesRegistry.eventId, eventId), eq(modulesRegistry.organizationId, org)));
    if (mods.length)
      await tx.insert(modulesRegistry).values(mods.map((m) => ({ organizationId: org, eventId: newId, moduleType: m.moduleType, configuration: m.configuration })));

    const srcTasks = await tx.select().from(tasks).where(and(eq(tasks.eventId, eventId), eq(tasks.organizationId, org))).orderBy(asc(tasks.createdAt));
    const idMap = new Map<string, string>(srcTasks.map((t) => [t.id, randomUUID()]));
    if (srcTasks.length)
      await tx.insert(tasks).values(srcTasks.map((t) => ({
        id: idMap.get(t.id)!,
        organizationId: org,
        eventId: newId,
        title: t.title,
        status: "TODO" as const,
        isAiGenerated: t.isAiGenerated,
        aiFingerprint: t.aiFingerprint,
        blueprintKey: t.blueprintKey,
        description: t.description,
        workstream: t.workstream,
        board: t.board,
        phase: t.phase,
        priority: t.priority,
        dueOffsetDays: t.dueOffsetDays,
        dueDate: t.dueOffsetDays !== null && startDate ? addDays(startDate, t.dueOffsetDays) : null,
        assigneeRole: t.assigneeRole,
        dependsOn: t.dependsOn.map((d) => idMap.get(d)).filter((d): d is string => !!d),
        position: t.position,
      })));

    const kpis = await tx.select().from(eventKpis).where(and(eq(eventKpis.eventId, eventId), eq(eventKpis.organizationId, org)));
    if (kpis.length)
      await tx.insert(eventKpis).values(kpis.map((k) => ({
        organizationId: org,
        eventId: newId,
        metricName: k.metricName,
        targetValue: k.targetValue,
        dataSource: k.dataSource,
        status: k.status,
        metricVersion: k.metricVersion,
        objectiveIndex: k.objectiveIndex,
        rationale: k.rationale,
        aiFingerprint: k.aiFingerprint,
      })));

    const srcSurveys = await tx.select().from(surveys).where(and(eq(surveys.eventId, eventId), eq(surveys.organizationId, org))).orderBy(asc(surveys.createdAt));
    for (const sv of srcSurveys) {
      const [copy] = await tx
        .insert(surveys)
        .values({
          organizationId: org,
          eventId: newId,
          audience: sv.audience,
          version: 1,
          status: "DRAFT",
          title: sv.title,
          intro: sv.intro,
          targetResponses: sv.targetResponses,
          isAiGenerated: sv.isAiGenerated,
          blueprintKey: sv.blueprintKey,
          aiFingerprint: sv.aiFingerprint,
        })
        .returning({ id: surveys.id });
      const qs = await tx.select().from(surveyQuestions).where(and(eq(surveyQuestions.surveyId, sv.id), eq(surveyQuestions.organizationId, org)));
      if (qs.length)
        await tx.insert(surveyQuestions).values(qs.map((q) => ({
          organizationId: org,
          eventId: newId,
          surveyId: copy!.id,
          questionText: q.questionText,
          type: q.type,
          isMandatory: q.isMandatory,
          position: q.position,
          audience: q.audience,
          questionKey: q.questionKey,
          options: q.options,
          metadata: q.metadata,
          isSensitive: q.isSensitive,
          aiFingerprint: q.aiFingerprint,
        })));
    }
    return { id: newId, title: ev!.title, copied: { modules: mods.length, tasks: srcTasks.length, kpis: kpis.length, surveys: srcSurveys.length } };
  });
}

export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  // quote always; neutralise spreadsheet formulas (CSV injection)
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** The event's tickets as CSV (UTF-8 with BOM so Excel shows Turkish letters). No QR token is exported. */
export async function attendeesCsv(access: OrgAccess, eventId: string) {
  await eventOf(access, eventId);
  const rows = await adminDb
    .select({ id: attendees.id, ticketType: attendees.ticketType, isCheckedIn: attendees.isCheckedIn, checkedInAt: attendees.checkedInAt, cancelledAt: attendees.cancelledAt, createdAt: attendees.createdAt })
    .from(attendees)
    .where(and(eq(attendees.eventId, eventId), eq(attendees.organizationId, access.organizationId)))
    .orderBy(asc(attendees.createdAt), asc(attendees.id));
  const header = ["Bilet No", "Bilet Türü", "Durum", "Giriş Zamanı", "İptal Zamanı", "Oluşturulma"];
  const lines = rows.map((r) => [
    `EIP-${r.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    r.ticketType,
    r.cancelledAt ? "İptal" : r.isCheckedIn ? "Giriş yaptı" : "Bekliyor",
    r.checkedInAt,
    r.cancelledAt,
    r.createdAt,
  ].map(csvCell).join(";"));
  return "﻿" + [header.map(csvCell).join(";"), ...lines].join("\r\n") + "\r\n";
}
