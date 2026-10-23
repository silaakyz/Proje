/**
 * Proposal operations: the only way AI output becomes database rows.
 *
 * The Blueprint stages and (later) the Copilot both emit `ProposalOperation[]` into
 * ai_action_proposals. Applying replays them through server/planning/apply-proposal.ts.
 * Pure and serialisable, so the approval card can render and the organizer can untick ops.
 */
import { z } from "zod";
import { blueprintCoreSchema, type BlueprintCore } from "@/lib/ai/blueprint/core";
import { plannedTaskSchema, type PlannedTask } from "@/lib/ai/blueprint/sections/tasks";
import type { PlannedKpi } from "@/lib/ai/blueprint/sections/kpis";
import type { PlannedSurvey } from "@/lib/ai/blueprint/sections/surveys";
import type { PlannedBudgetLine, PlannedRisk } from "@/lib/ai/blueprint/sections/budget-risks";
import { formFieldSchema, ticketTypeSchema } from "@/lib/ai/schemas/event-config";
import { SURVEY_AUDIENCES, TASK_PRIORITIES } from "@/lib/domain/enums";
import { surveyQuestionSchema } from "@/lib/metrics/question-bank";

export const proposalOperationSchema = z.discriminatedUnion("entity", [
  z.object({ op: z.literal("create"), entity: z.literal("event"), data: blueprintCoreSchema }),
  z.object({ op: z.literal("upsert"), entity: z.literal("ticket_type"), data: ticketTypeSchema }),
  z.object({ op: z.literal("upsert"), entity: z.literal("form_field"), data: formFieldSchema }),
  z.object({ op: z.literal("upsert"), entity: z.literal("task"), data: plannedTaskSchema }),
  z.object({
    op: z.literal("upsert"), entity: z.literal("kpi"),
    data: z.object({ metricKey: z.string(), objectiveIndex: z.number().int().nullable(), target: z.number().nullable(),
      targetBasis: z.string().nullable(), rationale: z.string() }),
  }),
  z.object({
    op: z.literal("upsert"), entity: z.literal("survey"),
    data: z.object({ key: z.string(), audience: z.enum(SURVEY_AUDIENCES), title: z.string(), intro: z.string(),
      questions: z.array(surveyQuestionSchema).min(1).max(40)
        .refine((qs) => new Set(qs.map((q) => q.key)).size === qs.length, "duplicate question keys"),
      targetResponses: z.number().int().positive().nullable() }),
  }),
  z.object({
    op: z.literal("upsert"), entity: z.literal("budget_line"),
    data: z.object({ key: z.string(), direction: z.enum(["EXPENSE", "INCOME"]), category: z.string(), label: z.string(),
      plannedAmountMinor: z.number().int().nullable(), notes: z.string().nullable() }),
  }),
  z.object({
    op: z.literal("upsert"), entity: z.literal("risk"),
    data: z.object({ key: z.string(), title: z.string(), description: z.string().nullable(), category: z.string(),
      likelihood: z.number().int().min(1).max(5), impact: z.number().int().min(1).max(5),
      mitigation: z.string().nullable(), ownerRole: z.string().nullable() }),
  }),
  // Copilot-shaped edit, used from V0.2 on: change fields of one existing task.
  z.object({
    op: z.literal("update"), entity: z.literal("task_patch"),
    id: z.uuid(),
    patch: z.object({
      title: z.string().min(3).max(140).optional(),
      status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      dueAt: z.iso.date().nullable().optional(),
      assigneeId: z.uuid().nullable().optional(),
    }),
  }),
]);
export type ProposalOperation = z.infer<typeof proposalOperationSchema>;
export const proposalOperationsSchema = z.array(proposalOperationSchema).min(1).max(500);

export interface ProposalDraft {
  kind: string;
  title: string;
  rationale: string | null;
  operations: ProposalOperation[];
}

export const coreProposal = (core: BlueprintCore): ProposalDraft => ({
  kind: "blueprint.core",
  title: `${core.event.title}: etkinlik profili, ${core.modules.length} modül, ${core.stakeholders.length} paydaş`,
  rationale: core.assumptions.length ? `Varsayımlar: ${core.assumptions.join(" · ")}` : null,
  operations: [{ op: "create", entity: "event", data: core }],
});

export const tasksProposal = (tasks: PlannedTask[], warnings: string[]): ProposalDraft => ({
  kind: "blueprint.tasks",
  title: `${tasks.length} görev (${tasks.filter((t) => t.board === "MEASUREMENT").length} ölçüm görevi)`,
  rationale: warnings.length ? warnings.join(" ") : null,
  operations: tasks.map((data) => ({ op: "upsert", entity: "task", data })),
});

/**
 * Evidence status comes from analytics.metric_definitions. Anything other than REVIEWED is stated
 * explicitly on the card, so an unreviewed definition is never presented as validated.
 * Missing status (metric not found) is treated as unreviewed.
 */
export const kpisProposal = (
  kpis: PlannedKpi[],
  warnings: string[],
  evidence: Record<string, "UNREVIEWED" | "IN_REVIEW" | "REVIEWED" | "DEPRECATED"> = {},
): ProposalDraft => {
  const unreviewed = kpis.filter((k) => evidence[k.metricKey] !== "REVIEWED").map((k) => k.metricKey);
  const notes = [
    ...warnings,
    ...(unreviewed.length
      ? [`Kanıt durumu: ${unreviewed.length === kpis.length ? "Seçilen KPI tanımlarının hiçbiri" : `${unreviewed.join(", ")} tanımları`} henüz literatür incelemesinden geçmedi.`]
      : []),
  ];
  return {
    kind: "blueprint.kpis",
    title: `${kpis.length} KPI`,
    rationale: notes.length ? notes.join(" ") : null,
    operations: kpis.map((data) => ({ op: "upsert", entity: "kpi", data })),
  };
};

export const surveysProposal = (surveys: PlannedSurvey[]): ProposalDraft => ({
  kind: "blueprint.surveys",
  title: `${surveys.length} anket taslağı (${surveys.reduce((n, s) => n + s.questions.length, 0)} soru)`,
  rationale: null,
  operations: surveys.map((s) => ({
    op: "upsert", entity: "survey",
    data: s,
  })),
});

export const budgetRisksProposal = (lines: PlannedBudgetLine[], risks: PlannedRisk[], warnings: string[]): ProposalDraft => ({
  kind: "blueprint.budget_risks",
  title: `${lines.length} bütçe kalemi, ${risks.length} risk`,
  rationale: warnings.length ? warnings.join(" ") : null,
  operations: [
    ...lines.map((data) => ({ op: "upsert" as const, entity: "budget_line" as const, data })),
    ...risks.map((data) => ({ op: "upsert" as const, entity: "risk" as const, data })),
  ],
});

export const registrationProposal = (
  ticketTypes: z.infer<typeof ticketTypeSchema>[],
  formFields: z.infer<typeof formFieldSchema>[],
  warnings: string[],
): ProposalDraft => ({
  kind: "blueprint.registration",
  title: `${ticketTypes.length} bilet türü, ${formFields.length} form alanı`,
  rationale: warnings.length ? warnings.join(" ") : null,
  operations: [
    ...ticketTypes.map((data) => ({ op: "upsert" as const, entity: "ticket_type" as const, data })),
    ...formFields.map((data) => ({ op: "upsert" as const, entity: "form_field" as const, data })),
  ],
});
