/**
 * Blueprint section — budget skeleton and risk register.
 *
 * Budget lines are *identified*, not priced: an amount is kept only when the organizer stated it.
 * Risks use a 1–5 likelihood × impact grid so the workspace can sort and colour them.
 */
import { z } from "zod";
import { toMachineKey, toPositiveInt } from "@/lib/ai/schemas/event-config";
import type { BlueprintCore } from "@/lib/ai/blueprint/core";
import { vocabularyFor } from "@/lib/modules/registry";

export const RISK_CATEGORIES = [
  "weather", "crowd", "security", "health", "supplier", "financial", "permits", "technical", "reputation", "accessibility", "environment",
] as const;
export const INCOME_CATEGORIES = ["sponsorship_income", "ticket_income", "grant_income", "public_funding", "other_income"] as const;

export function buildBudgetRisksDraftSchema(workstreams: readonly string[]) {
  const expenseCats = z.enum(workstreams as [string, ...string[]]);
  return z.object({
    budgetLines: z
      .array(
        z.object({
          key: z.string(),
          direction: z.enum(["EXPENSE", "INCOME"]),
          expenseCategory: expenseCats.nullable().describe("Workstream for EXPENSE lines; null for INCOME."),
          incomeCategory: z.enum(INCOME_CATEGORIES).nullable().describe("For INCOME lines; null for EXPENSE."),
          label: z.string().describe("Turkish, e.g. 'Sahne ve ses sistemi kiralama'."),
          plannedAmountTry: z.number().nullable().describe("ONLY if the organizer stated this specific amount. Never estimate or split a total."),
          notes: z.string().nullable(),
        }),
      )
      .describe("10–40 lines covering the enabled workstreams."),
    risks: z
      .array(
        z.object({
          key: z.string(),
          title: z.string(),
          description: z.string().nullable(),
          category: z.enum(RISK_CATEGORIES),
          likelihood: z.number().describe("1 (rare) – 5 (almost certain)"),
          impact: z.number().describe("1 (negligible) – 5 (event cannot continue)"),
          mitigation: z.string().describe("Concrete preventive action, Turkish."),
          ownerRole: z.string().nullable(),
        }),
      )
      .describe("8–25 risks specific to this event's type, scale, season and location."),
  });
}
export type BudgetRisksDraft = z.infer<ReturnType<typeof buildBudgetRisksDraftSchema>>;

export interface PlannedBudgetLine {
  key: string;
  direction: "EXPENSE" | "INCOME";
  category: string;
  label: string;
  plannedAmountMinor: number | null;
  notes: string | null;
}
export interface PlannedRisk {
  key: string;
  title: string;
  description: string | null;
  category: (typeof RISK_CATEGORIES)[number];
  likelihood: number;
  impact: number;
  mitigation: string | null;
  ownerRole: string | null;
}

const clamp15 = (n: number) => Math.min(5, Math.max(1, Math.round(Number.isFinite(n) ? n : 3)));

export function normalizeBudgetRisks(draft: BudgetRisksDraft, core: BlueprintCore) {
  const repairs: string[] = [];
  const warnings: string[] = [];
  const ws = new Set(vocabularyFor(core.modules.map((m) => m.key)).workstreams);

  const usedB = new Set<string>();
  const budgetLines: PlannedBudgetLine[] = draft.budgetLines.slice(0, 40).map((b, i) => {
    let key = toMachineKey(b.key || b.label, `budget_${i + 1}`);
    while (usedB.has(key)) key = `${key.slice(0, 44)}_${i + 1}`;
    usedB.add(key);
    const category =
      b.direction === "INCOME"
        ? b.incomeCategory ?? "other_income"
        : b.expenseCategory && ws.has(b.expenseCategory) ? b.expenseCategory : "logistics";
    const amount = toPositiveInt(b.plannedAmountTry);
    return { key, direction: b.direction, category, label: b.label.trim().slice(0, 160), plannedAmountMinor: amount != null ? amount * 100 : null, notes: b.notes?.trim() || null };
  });

  const planned = budgetLines.filter((b) => b.direction === "EXPENSE").reduce((s, b) => s + (b.plannedAmountMinor ?? 0), 0);
  if (core.budgetTotalMinor != null && planned > core.budgetTotalMinor)
    warnings.push(`Tutarı girilmiş gider kalemleri toplamı (${planned / 100} TL) belirtilen toplam bütçeyi aşıyor.`);

  const usedR = new Set<string>();
  const risks: PlannedRisk[] = draft.risks.slice(0, 25).map((r, i) => {
    let key = toMachineKey(r.key || r.title, `risk_${i + 1}`);
    while (usedR.has(key)) key = `${key.slice(0, 44)}_${i + 1}`;
    usedR.add(key);
    const likelihood = clamp15(r.likelihood);
    const impact = clamp15(r.impact);
    if (likelihood !== r.likelihood || impact !== r.impact) repairs.push(`risk '${key}': scores clamped to 1–5`);
    return { key, title: r.title.trim().slice(0, 160), description: r.description?.trim() || null, category: r.category,
      likelihood, impact, mitigation: r.mitigation.trim() || null, ownerRole: r.ownerRole?.trim() || null };
  });
  risks.sort((a, b) => b.likelihood * b.impact - a.likelihood * a.impact);

  return { budgetLines, risks, repairs, warnings };
}
