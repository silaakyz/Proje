/**
 * Blueprint section — task plan.
 *
 * The schema is built per event: `workstream` is an enum of the enabled modules' workstreams, so the
 * model cannot invent categories the workspace has no column for. Due dates are offsets from event
 * day 0, so moving the event date re-flows the whole plan.
 */
import { z } from "zod";
import { EVENT_PHASES, STAKEHOLDER_KINDS, TASK_BOARDS, TASK_PRIORITIES } from "@/lib/domain/enums";
import { addDays, toMachineKey } from "@/lib/ai/schemas/event-config";
import type { BlueprintCore } from "@/lib/ai/blueprint/core";
import { vocabularyFor } from "@/lib/modules/registry";

export const MAX_TASKS = 80;

export function buildTasksDraftSchema(workstreams: readonly string[]) {
  if (workstreams.length === 0) throw new Error("no workstreams enabled");
  const ws = z.enum(workstreams as [string, ...string[]]);
  return z.object({
    tasks: z
      .array(
        z.object({
          key: z.string().describe("Stable snake_case id, unique, e.g. 'venue_contract_signed'."),
          title: z.string().describe("Imperative, Turkish, max ~80 chars. e.g. 'Mekân sözleşmesini imzala'."),
          description: z.string().nullable().describe("1–2 sentences of concrete done-criteria, or null."),
          workstream: ws,
          board: z.enum(TASK_BOARDS).describe("PLANNING for preparation, OPERATIONS for event-day/on-site work, MEASUREMENT for data collection and reporting."),
          phase: z.enum(EVENT_PHASES),
          priority: z.enum(TASK_PRIORITIES).describe("CRITICAL only if the event cannot happen without it."),
          dueOffsetDays: z
            .number()
            .nullable()
            .describe("Days relative to event day 0 (first day). Negative = before. e.g. -90, -14, 0, +7. null if not time-bound."),
          assigneeRole: z.string().nullable().describe("Role, not a person: 'Proje yöneticisi', 'Sponsorluk sorumlusu'."),
          dependsOnKeys: z.array(z.string()).describe("Keys of tasks that must finish first."),
          stakeholderKind: z.enum(STAKEHOLDER_KINDS).nullable().describe("Stakeholder type this task is about, if any."),
        }),
      )
      .describe(`A realistic end-to-end plan, 20–${MAX_TASKS} tasks, covering every enabled workstream that applies.`),
    assumptions: z.array(z.string()),
  });
}
export type TasksDraft = z.infer<ReturnType<typeof buildTasksDraftSchema>>;
type DraftTask = TasksDraft["tasks"][number];

export const plannedTaskSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
  title: z.string().min(3).max(140),
  description: z.string().max(1000).nullable(),
  workstream: z.string(),
  board: z.enum(TASK_BOARDS),
  phase: z.enum(EVENT_PHASES),
  priority: z.enum(TASK_PRIORITIES),
  dueOffsetDays: z.number().int().min(-730).max(180).nullable(),
  dueDate: z.iso.date().nullable(),
  assigneeRole: z.string().max(80).nullable(),
  dependsOnKeys: z.array(z.string()),
  stakeholderKind: z.enum(STAKEHOLDER_KINDS).nullable(),
  position: z.string(),
});
export type PlannedTask = z.infer<typeof plannedTaskSchema>;

export interface TasksResult {
  tasks: PlannedTask[];
  repairs: string[];
  warnings: string[];
}

/** Lexicographically sortable fractional positions: a0000, a0001 … */
const positionAt = (i: number) => `a${i.toString(36).padStart(4, "0")}`;

/** Phase implied by the due offset, used to repair obviously wrong phases. */
function phaseForOffset(offset: number | null, board: PlannedTask["board"]): PlannedTask["phase"] | null {
  if (offset == null) return null;
  if (offset > 0) return board === "MEASUREMENT" ? "ANALYZE" : "IMPROVE";
  if (offset === 0) return "RUN";
  return null; // before the event: PLAN/PREPARE/MANAGE are all plausible — trust the model
}

export function normalizeTasks(draft: TasksDraft, core: BlueprintCore): TasksResult {
  const repairs: string[] = [];
  const warnings: string[] = [];
  const vocab = vocabularyFor(core.modules.map((m) => m.key));
  const allowedWs = new Set(vocab.workstreams);
  const start = core.event.startDate;
  const lastDayOffset = (core.event.durationDays ?? 1) - 1;

  const src = draft.tasks.slice(0, MAX_TASKS);
  if (draft.tasks.length > MAX_TASKS) repairs.push(`trimmed tasks to ${MAX_TASKS}`);

  // keys
  const keyMap = new Map<string, string>();
  const used = new Set<string>();
  const withKeys = src.map((t, i) => {
    let key = toMachineKey(t.key || t.title, `task_${i + 1}`);
    while (used.has(key)) key = `${key.slice(0, 44)}_${i + 1}`;
    used.add(key);
    if (!keyMap.has(t.key)) keyMap.set(t.key, key);
    return { t, key };
  });

  const tasks: PlannedTask[] = withKeys.map(({ t, key }, i) => {
    const workstream = allowedWs.has(t.workstream) ? t.workstream : "strategy";
    if (workstream !== t.workstream) repairs.push(`task '${key}': unknown workstream → strategy`);

    let offset = t.dueOffsetDays == null || !Number.isFinite(t.dueOffsetDays) ? null : Math.round(t.dueOffsetDays);
    if (offset != null && (offset < -730 || offset > 180)) {
      repairs.push(`task '${key}': offset ${offset} out of range; cleared`);
      offset = null;
    }
    // Event-day tasks on a multi-day event fall on any day 0..lastDayOffset → keep RUN
    const implied = offset != null && offset > 0 && offset <= lastDayOffset ? "RUN" : phaseForOffset(offset, t.board);
    const phase = implied ?? t.phase;
    if (phase !== t.phase) repairs.push(`task '${key}': phase ${t.phase} → ${phase} from due offset`);

    return {
      key,
      title: t.title.trim().slice(0, 140),
      description: t.description?.trim() || null,
      workstream,
      board: t.board,
      phase,
      priority: t.priority,
      dueOffsetDays: offset,
      dueDate: start && offset != null ? addDays(start, offset) : null,
      assigneeRole: t.assigneeRole?.trim().slice(0, 80) || null,
      dependsOnKeys: [] as string[],
      stakeholderKind: t.stakeholderKind,
      position: positionAt(i),
    };
  });

  // dependencies: resolve keys, drop unknown/self, then break cycles
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  withKeys.forEach(({ t }: { t: DraftTask }, i) => {
    const deps = [...new Set(t.dependsOnKeys.map((k) => keyMap.get(k) ?? toMachineKey(k, "")))].filter(
      (k) => byKey.has(k) && k !== tasks[i]!.key,
    );
    tasks[i]!.dependsOnKeys = deps;
  });
  breakCycles(tasks, repairs);

  // scheduling sanity: a task due before something it depends on
  for (const t of tasks) {
    for (const d of t.dependsOnKeys) {
      const dep = byKey.get(d)!;
      if (t.dueOffsetDays != null && dep.dueOffsetDays != null && dep.dueOffsetDays > t.dueOffsetDays)
        warnings.push(`'${t.key}' (gün ${t.dueOffsetDays}) bağımlı olduğu '${d}' görevinden (gün ${dep.dueOffsetDays}) önce bitiyor.`);
    }
  }

  // coverage: every enabled workstream should have at least one task
  const covered = new Set(tasks.map((t) => t.workstream));
  for (const ws of vocab.workstreams)
    if (!covered.has(ws) && ws !== "permits") warnings.push(`'${vocab.workstreamLabels[ws] ?? ws}' iş akışında görev yok.`);

  return { tasks: tasks.map((t) => plannedTaskSchema.parse(t)), repairs, warnings };
}

/** Removes the edge that closes each cycle (DFS), so the dependency graph is a DAG. */
function breakCycles(tasks: PlannedTask[], repairs: string[]) {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const state = new Map<string, 0 | 1 | 2>(); // 0/undefined new, 1 on stack, 2 done
  const visit = (t: PlannedTask) => {
    state.set(t.key, 1);
    t.dependsOnKeys = t.dependsOnKeys.filter((d) => {
      const s = state.get(d);
      if (s === 1) {
        repairs.push(`removed cyclic dependency ${t.key} → ${d}`);
        return false;
      }
      if (s !== 2) visit(byKey.get(d)!);
      return true;
    });
    state.set(t.key, 2);
  };
  for (const t of tasks) if (!state.get(t.key)) visit(t);
}
