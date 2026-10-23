/**
 * Tasks and KPIs of an event for the organizer UI, under RLS as the caller. Members read them; any
 * member may move a task's status (column privilege: tasks.status/updated_at only, 0003).
 * Other edits to tasks/KPIs go through AI proposals (POST /api/proposals/:id).
 */
import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { eventKpis, taskStatus, tasks } from "@/db/schema";
import type { UserDbRunner } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";

export const updateTaskStatusSchema = z.object({ organizationId: z.uuid(), status: z.enum(taskStatus.enumValues) });

export function listTasks(runAsUser: UserDbRunner, organizationId: string, eventId: string) {
  return runAsUser((tx) =>
    tx
      .select({
        id: tasks.id, title: tasks.title, description: tasks.description, status: tasks.status, board: tasks.board, phase: tasks.phase,
        priority: tasks.priority, workstream: tasks.workstream, dueDate: tasks.dueDate, dueOffsetDays: tasks.dueOffsetDays,
        assigneeRole: tasks.assigneeRole, assignedTo: tasks.assignedTo, dependsOn: tasks.dependsOn, isAiGenerated: tasks.isAiGenerated,
        position: tasks.position, updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(and(eq(tasks.organizationId, organizationId), eq(tasks.eventId, eventId)))
      .orderBy(asc(tasks.board), sql`${tasks.dueOffsetDays} asc nulls last`, asc(tasks.title)),
  );
}

export async function updateTaskStatus(runAsUser: UserDbRunner, taskId: string, input: z.infer<typeof updateTaskStatusSchema>) {
  const rows = await runAsUser((tx) =>
    tx.update(tasks).set({ status: input.status, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, input.organizationId)))
      .returning({ id: tasks.id, eventId: tasks.eventId, status: tasks.status, updatedAt: tasks.updatedAt }),
  );
  if (!rows[0]) throw new ApiError(404, "Task not found");
  return rows[0];
}

export function listKpis(runAsUser: UserDbRunner, organizationId: string, eventId: string) {
  return runAsUser((tx) =>
    tx
      .select({
        id: eventKpis.id, metricName: eventKpis.metricName, status: eventKpis.status, dataSource: eventKpis.dataSource,
        targetValue: eventKpis.targetValue, actualValue: eventKpis.actualValue, objectiveIndex: eventKpis.objectiveIndex,
        rationale: eventKpis.rationale, metricVersion: eventKpis.metricVersion,
      })
      .from(eventKpis)
      .where(and(eq(eventKpis.organizationId, organizationId), eq(eventKpis.eventId, eventId)))
      .orderBy(asc(eventKpis.metricName)),
  );
}
