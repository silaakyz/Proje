/**
 * Event budget (budget_items): planned and actual income and costs, the inputs of the finance metrics
 * (src/lib/kpi/engine.ts, KPI reference §3.4) and of the organizer's local spend (§3.10). Server-only table: routes
 * check budget.read / budget.manage (owner, admin) and every query is scoped to the caller's organization.
 * Amounts are integer kuruş in the database and TRY (2 decimals) in the API.
 */
import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { budgetItems, events } from "@/db/schema";
import { BUDGET_CATEGORIES, BUDGET_CATEGORY_LABEL, BUDGET_KIND_LABEL, BUDGET_KINDS, COST_BEHAVIOR_LABEL, COST_BEHAVIORS,
  MAX_BUDGET_KURUS, type BudgetKind, type CostBehavior } from "@/lib/budget/categories";
import type { OrgAccess } from "@/server/auth/org-access";
import { csvCell } from "@/server/events/lifecycle-service";
import { ApiError } from "@/server/http";

const MAX_TRY = MAX_BUDGET_KURUS / 100;
const amount = z.number().finite().min(0).max(MAX_TRY).refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "at most 2 decimals");

const fields = {
  label: z.string().trim().min(1).max(200),
  planned: amount.nullable(),
  actual: amount.nullable(),
  quantity: z.number().int().min(0).max(10_000_000).nullable(),
  costBehavior: z.enum(COST_BEHAVIORS).nullable(),
  supplierLocal: z.boolean().nullable(),
  fundedExternally: z.boolean().nullable(),
  notes: z.string().trim().max(1000).nullable(),
};

type Line = { kind: BudgetKind; category: string; planned: number | null; actual: number | null; quantity: number | null;
  costBehavior: CostBehavior | null; supplierLocal: boolean | null; fundedExternally: boolean | null };

/** The same rules the database enforces, as 400s with a field path. */
function lineIssues(l: Line, ctx: z.RefinementCtx) {
  if (!(BUDGET_CATEGORIES[l.kind] as readonly string[]).includes(l.category)) ctx.addIssue({ code: "custom", path: ["category"], message: "category does not belong to kind" });
  if (l.planned === null && l.actual === null) ctx.addIssue({ code: "custom", path: ["actual"], message: "a planned or an actual amount is required" });
  if (l.quantity !== null && !(l.kind === "INCOME" && l.category === "TICKETS")) ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity only on ticket income" });
  if (l.kind !== "COST" && (l.costBehavior !== null || l.supplierLocal !== null || l.fundedExternally !== null)) {
    ctx.addIssue({ code: "custom", path: ["costBehavior"], message: "cost fields only on cost lines" });
  }
}

export const createBudgetItemSchema = z.object({
  organizationId: z.uuid(),
  kind: z.enum(BUDGET_KINDS),
  category: z.string(),
  label: fields.label,
  planned: fields.planned.default(null),
  actual: fields.actual.default(null),
  quantity: fields.quantity.default(null),
  costBehavior: fields.costBehavior.default(null),
  supplierLocal: fields.supplierLocal.default(null),
  fundedExternally: fields.fundedExternally.default(null),
  notes: fields.notes.default(null),
}).superRefine(lineIssues);

/** Kind and category may change too; the merged line is validated as a whole. */
export const updateBudgetItemSchema = z.object({
  organizationId: z.uuid(),
  kind: z.enum(BUDGET_KINDS).optional(),
  category: z.string().optional(),
  label: fields.label.optional(),
  planned: fields.planned.optional(),
  actual: fields.actual.optional(),
  quantity: fields.quantity.optional(),
  costBehavior: fields.costBehavior.optional(),
  supplierLocal: fields.supplierLocal.optional(),
  fundedExternally: fields.fundedExternally.optional(),
  notes: fields.notes.optional(),
});

const toKurus = (n: number | null) => (n === null ? null : Math.round(n * 100));
const toTry = (k: number | null) => (k === null ? null : k / 100);

type Row = typeof budgetItems.$inferSelect;
const toItem = (r: Row) => ({
  id: r.id, eventId: r.eventId, kind: r.kind as BudgetKind, category: r.category, label: r.label,
  planned: toTry(r.plannedKurus), actual: toTry(r.actualKurus), quantity: r.quantity,
  costBehavior: r.costBehavior as CostBehavior | null, supplierLocal: r.supplierLocal, fundedExternally: r.fundedExternally,
  notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt,
});
export type BudgetItem = ReturnType<typeof toItem>;

async function eventOf(organizationId: string, eventId: string) {
  const [ev] = await adminDb.select({ id: events.id }).from(events)
    .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
}

/** Planned / actual totals per kind (TRY), summed in kuruş. */
function totals(items: readonly BudgetItem[]) {
  const by = (kind: BudgetKind) => {
    const ls = items.filter((i) => i.kind === kind);
    const sum = (k: "planned" | "actual") => {
      const xs = ls.filter((i) => i[k] !== null);
      return xs.length ? xs.reduce((s, i) => s + Math.round(i[k]! * 100), 0) / 100 : null;
    };
    return { planned: sum("planned"), actual: sum("actual"), lines: ls.length };
  };
  const income = by("INCOME");
  const cost = by("COST");
  const net = (k: "planned" | "actual") => (income[k] === null && cost[k] === null ? null : ((income[k] ?? 0) * 100 - (cost[k] ?? 0) * 100) / 100);
  return { income, cost, ticketAdjustments: by("TICKET_ADJUSTMENT"), net: { planned: net("planned"), actual: net("actual") } };
}

export async function listBudget(organizationId: string, eventId: string) {
  await eventOf(organizationId, eventId);
  const rows = await adminDb.select().from(budgetItems)
    .where(and(eq(budgetItems.organizationId, organizationId), eq(budgetItems.eventId, eventId)))
    .orderBy(asc(budgetItems.kind), asc(budgetItems.createdAt), asc(budgetItems.id));
  const items = rows.map(toItem);
  return { items, totals: totals(items) };
}

export async function createBudgetItem(access: OrgAccess, eventId: string, input: z.infer<typeof createBudgetItemSchema>) {
  await eventOf(access.organizationId, eventId);
  const [row] = await adminDb.insert(budgetItems).values({
    organizationId: access.organizationId, eventId, kind: input.kind, category: input.category, label: input.label,
    plannedKurus: toKurus(input.planned), actualKurus: toKurus(input.actual), quantity: input.quantity, costBehavior: input.costBehavior,
    supplierLocal: input.supplierLocal, fundedExternally: input.fundedExternally, notes: input.notes || null, createdBy: access.userId,
  }).returning();
  return toItem(row!);
}

async function itemOf(organizationId: string, itemId: string) {
  const [row] = await adminDb.select().from(budgetItems)
    .where(and(eq(budgetItems.id, itemId), eq(budgetItems.organizationId, organizationId))).limit(1);
  if (!row) throw new ApiError(404, "Budget item not found");
  return row;
}

export async function updateBudgetItem(organizationId: string, itemId: string, input: z.infer<typeof updateBudgetItemSchema>) {
  const cur = toItem(await itemOf(organizationId, itemId));
  const { organizationId: _org, ...patch } = input;
  const merged = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as BudgetItem;
  // A line that is no longer a cost / ticket income drops the fields that only apply there.
  if (merged.kind !== "COST") Object.assign(merged, { costBehavior: null, supplierLocal: null, fundedExternally: null });
  if (!(merged.kind === "INCOME" && merged.category === "TICKETS")) merged.quantity = null;
  const check = createBudgetItemSchema.safeParse({ ...merged, organizationId, notes: merged.notes ?? null });
  if (!check.success) throw check.error;
  const [row] = await adminDb.update(budgetItems).set({
    kind: merged.kind, category: merged.category, label: merged.label, plannedKurus: toKurus(merged.planned), actualKurus: toKurus(merged.actual),
    quantity: merged.quantity, costBehavior: merged.costBehavior, supplierLocal: merged.supplierLocal, fundedExternally: merged.fundedExternally,
    notes: merged.notes || null, updatedAt: new Date(),
  }).where(and(eq(budgetItems.id, itemId), eq(budgetItems.organizationId, organizationId))).returning();
  return toItem(row!);
}

export async function deleteBudgetItem(organizationId: string, itemId: string) {
  await itemOf(organizationId, itemId);
  await adminDb.delete(budgetItems).where(and(eq(budgetItems.id, itemId), eq(budgetItems.organizationId, organizationId)));
}

/** The budget as CSV (UTF-8 with BOM, ";" separated, amounts with a decimal comma for Turkish Excel). */
export async function budgetCsv(organizationId: string, eventId: string) {
  const { items } = await listBudget(organizationId, eventId);
  const money = (n: number | null) => (n === null ? "" : n.toFixed(2).replace(".", ","));
  const yesNo = (b: boolean | null) => (b === null ? "" : b ? "Evet" : "Hayır");
  const header = ["Tür", "Kategori", "Kalem", "Planlanan (TL)", "Gerçekleşen (TL)", "Bilet adedi", "Sabit/Değişken", "Yerel tedarikçi", "Dış finansman", "Not"];
  const lines = items.map((i) => [
    BUDGET_KIND_LABEL[i.kind], BUDGET_CATEGORY_LABEL[i.kind][i.category] ?? i.category, i.label, money(i.planned), money(i.actual),
    i.quantity, i.costBehavior ? COST_BEHAVIOR_LABEL[i.costBehavior] : "", yesNo(i.supplierLocal), yesNo(i.fundedExternally), i.notes,
  ].map(csvCell).join(";"));
  return "﻿" + [header.map(csvCell).join(";"), ...lines].join("\r\n") + "\r\n";
}
