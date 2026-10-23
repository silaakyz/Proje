/**
 * Applies / rejects AI proposals on the Drizzle data model.
 *
 * Guarantees:
 *  - Exactly-once: the proposal is claimed (PENDING → APPROVED) as the transaction's first write; a
 *    concurrent or repeated apply blocks on the row lock and then sees NOT_PENDING.
 *  - All-or-nothing: every write of an apply is in ONE transaction. Any error rolls back everything,
 *    including the claim, so the proposal stays PENDING (with error_message) and can be retried.
 *  - Human edits win: the AI rewrites a row only while it still hashes to the fingerprint the AI last
 *    wrote; completed tasks, activated/dropped KPIs and opened surveys are never rewritten.
 *
 * Drizzle-specific:
 *  - "Applied" is stored as APPROVED (the DB enum has no APPLIED); the API still reports "APPLIED"
 *    (see PROPOSAL_API_STATUS).
 *  - ticket_type / form_field / budget_line / risk have no Drizzle tables yet, and tasks have no
 *    BLOCKED / CANCELLED status. A selection containing any of them is refused with INVALID before
 *    the transaction starts: nothing is written and nothing is skipped silently.
 *  - Event days, stakeholders and the stated total budget stay in events.ai_config (the validated core).
 *  - KPI metrics are checked against METRIC_LIBRARY (there is no metric_definitions table).
 *
 * Security: callers authorize first (requireOrgPermission(orgId, "proposal.decide")) and pass the
 * verified organizationId/actorId. Because adminDb bypasses RLS, the decider role is re-checked here,
 * and every statement is scoped by organization_id; composite FKs back this up in the database.
 */
import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import { adminDb } from "@/db";
import type { AppDatabase, AppTransaction } from "@/db/rls";
import { eventKpis, events, proposals, surveyQuestions, surveys, tasks, users } from "@/db/schema";
import { ORG_PERMISSIONS } from "@/server/auth/org-access";
import { markGenerationApplied } from "@/server/logistics/ai-generations-drizzle";
import { addDays } from "@/lib/ai/schemas/event-config";
import { BLUEPRINT_SCHEMA_VERSION, type BlueprintCore } from "@/lib/ai/blueprint/core";
import { proposalOperationsSchema, type ProposalOperation } from "@/lib/ai/blueprint/operations";
import type { MetricDataSourceValue } from "@/lib/domain/enums";
import { METRIC_LIBRARY } from "@/lib/metrics/library";
import type { SurveyQuestion } from "@/lib/metrics/question-bank";
import { ProposalError, toApiProposalStatus } from "@/server/planning/proposal-error";

export { ProposalError } from "@/server/planning/proposal-error";

type Db = AppDatabase | AppTransaction;

/** Roles allowed to apply or reject proposals (owner, admin). Re-checked here because adminDb bypasses RLS. */
export const APPLY_ROLES = ORG_PERMISSIONS["proposal.decide"];

export interface ApplyInput {
  proposalId: string;
  organizationId: string; // from requireOrgPermission — never from the request body alone
  actorId: string;
  /** Indexes of operations the organizer kept ticked. Omit = all. */
  opIndexes?: number[];
}

export interface ApplySummary {
  eventId: string;
  applied: number;
  created: Record<string, number>;
  updated: Record<string, number>;
  /** Rows deliberately left untouched (completed, activated, opened or edited by a person). */
  preserved: Record<string, number>;
}

/** Operations that have no Drizzle table in this port round. */
export const UNSUPPORTED_ENTITIES = ["ticket_type", "form_field", "budget_line", "risk"] as const;
/** task_patch statuses the Drizzle task_status enum cannot store. */
export const UNSUPPORTED_TASK_STATUSES = ["BLOCKED", "CANCELLED"] as const;

/** Every metric definition is at version 1 until definitions are versioned in the database. */
const METRIC_DEFINITION_VERSION = 1;

/**
 * event_kpis.data_source, by the agreed rule: SURVEY → survey, REGISTRATION/CHECKIN → ticket_sales,
 * every other source → system. A metric listing several sources takes the first rule that matches
 * (survey before ticket_sales before system), independent of the order in METRIC_LIBRARY.
 */
export const KPI_DATA_SOURCE: Record<MetricDataSourceValue, "survey" | "ticket_sales" | "system"> = {
  SURVEY: "survey",
  REGISTRATION: "ticket_sales",
  CHECKIN: "ticket_sales",
  MANUAL_ENTRY: "system",
  FILE_UPLOAD: "system",
  SOCIAL_MEDIA: "system",
  EXTERNAL_API: "system",
  FINANCE: "system",
};

async function assertDecider(db: Db, organizationId: string, actorId: string) {
  const [m] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorId), eq(users.organizationId, organizationId), inArray(users.role, [...APPLY_ROLES])))
    .limit(1);
  if (!m) throw new ProposalError("FORBIDDEN", "Not allowed to decide proposals");
}

/**
 * Refuses operations this data model cannot apply. Runs before any write: in applyProposal (on the
 * organizer's selection) and in saveProposal (so such a proposal is never stored in the first place).
 * `index` is the operation's position in the proposal, for the error message.
 */
export function assertOperationsSupported(selected: { op: ProposalOperation; index: number }[]) {
  const problems: string[] = [];
  for (const { op, index } of selected) {
    if ((UNSUPPORTED_ENTITIES as readonly string[]).includes(op.entity)) problems.push(`#${index} ${op.entity}`);
    if (op.entity === "task_patch" && op.patch.status && (UNSUPPORTED_TASK_STATUSES as readonly string[]).includes(op.patch.status))
      problems.push(`#${index} task_patch status ${op.patch.status}`);
  }
  if (problems.length)
    throw new ProposalError("INVALID", `Unsupported operations selected (${problems.join(", ")}); untick them or wait for support`);
}

export async function applyProposal(input: ApplyInput): Promise<ApplySummary> {
  const org = input.organizationId;
  await assertDecider(adminDb, org, input.actorId);

  const [proposal] = await adminDb
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, input.proposalId), eq(proposals.organizationId, org)))
    .limit(1);
  if (!proposal) throw new ProposalError("NOT_FOUND", "Proposal not found");
  if (proposal.status !== "PENDING") throw new ProposalError("NOT_PENDING", `Proposal is ${toApiProposalStatus(proposal.status)}`);
  const stillPending = and(eq(proposals.id, proposal.id), eq(proposals.organizationId, org), eq(proposals.status, "PENDING"));
  if (proposal.expiresAt < new Date()) {
    await adminDb.update(proposals).set({ status: "EXPIRED" }).where(stillPending);
    throw new ProposalError("EXPIRED", "Proposal expired; regenerate it");
  }

  const parsed = proposalOperationsSchema.safeParse((proposal.payload as { operations?: unknown }).operations);
  if (!parsed.success) {
    await adminDb
      .update(proposals)
      .set({ status: "FAILED", errorMessage: `Invalid operations: ${parsed.error.message.slice(0, 1800)}` })
      .where(stillPending);
    throw new ProposalError("INVALID", "Stored operations failed validation");
  }
  if (input.opIndexes) {
    const bad = input.opIndexes.filter((i) => i >= parsed.data.length);
    if (bad.length || input.opIndexes.length === 0) throw new ProposalError("INVALID", "Operation selection is empty or out of range");
  }
  const selected = parsed.data
    .map((op, index) => ({ op, index }))
    .filter(({ index }) => !input.opIndexes || input.opIndexes.includes(index));
  assertOperationsSupported(selected); // before the transaction: no claim, no error_message, no partial apply
  const ops = selected.map((s) => s.op);

  try {
    return await adminDb.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '30s'`);

      // 1. Claim. Row lock + status predicate = exactly-once.
      const claimed = await tx
        .update(proposals)
        .set({ status: "APPROVED", decidedBy: input.actorId, decidedAt: new Date(), appliedOps: input.opIndexes ?? null })
        .where(stillPending)
        .returning({ id: proposals.id });
      if (claimed.length !== 1) throw new ProposalError("NOT_PENDING", "Proposal was decided concurrently");
      await assertDecider(tx, org, input.actorId);

      const summary: ApplySummary = { eventId: "", applied: ops.length, created: {}, updated: {}, preserved: {} };

      let eventId = proposal.eventId;
      const creates = ops.filter((o) => o.entity === "event");
      if (creates.length) {
        if (eventId) throw new ProposalError("CONFLICT", "Event already exists for this proposal");
        eventId = await createEvent(tx, org, creates[0]!.data);
        bump(summary.created, "event");
      }
      if (!eventId) throw new ProposalError("NO_EVENT", "Apply the event profile first");

      const [event] = await tx
        .select({ startDate: events.startDate })
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.organizationId, org)))
        .limit(1);
      if (!event) throw new ProposalError("NOT_FOUND", "Event not in organization");

      const scope: Scope = { organizationId: org, eventId, proposalId: proposal.id, start: event.startDate };
      await applyOps(tx, scope, ops.filter((o) => o.entity !== "event"), summary);
      summary.eventId = eventId;

      await tx
        .update(proposals)
        .set({ eventId, errorMessage: null, appliedSummary: summary as unknown as Record<string, unknown> })
        .where(and(eq(proposals.id, proposal.id), eq(proposals.organizationId, org)));
      if (proposal.generationId) await markGenerationApplied(tx, org, proposal.generationId, eventId);
      return summary;
    });
  } catch (err) {
    // Transaction rolled back: proposal is still PENDING (unless someone else decided it). Record why.
    if (!(err instanceof ProposalError && (err.code === "NOT_PENDING" || err.code === "FORBIDDEN"))) {
      await adminDb
        .update(proposals)
        .set({ errorMessage: err instanceof Error ? err.message.slice(0, 2000) : String(err) })
        .where(stillPending);
    }
    throw err;
  }
}

/**
 * Marks the organization's PENDING proposals whose expires_at has passed as EXPIRED, so listings show
 * what can still be applied (applyProposal does the same for a single proposal on use). Server-only write.
 */
export async function expireStaleProposals(organizationId: string) {
  const rows = await adminDb
    .update(proposals)
    .set({ status: "EXPIRED", updatedAt: new Date() })
    .where(and(eq(proposals.organizationId, organizationId), eq(proposals.status, "PENDING"), sql`${proposals.expiresAt} < now()`))
    .returning({ id: proposals.id });
  return rows.length;
}

export async function rejectProposal(proposalId: string, organizationId: string, actorId: string) {
  await assertDecider(adminDb, organizationId, actorId);
  const rows = await adminDb
    .update(proposals)
    .set({ status: "REJECTED", decidedBy: actorId, decidedAt: new Date() })
    .where(and(eq(proposals.id, proposalId), eq(proposals.organizationId, organizationId), eq(proposals.status, "PENDING")))
    .returning({ id: proposals.id });
  if (!rows.length) throw new ProposalError("NOT_PENDING", "Proposal is not pending");
}

// ---------------------------------------------------------------------------

interface Scope {
  organizationId: string;
  eventId: string;
  proposalId: string;
  /** events.start_date as YYYY-MM-DD, or null. */
  start: string | null;
}

const bump = (bucket: Record<string, number>, k: string) => (bucket[k] = (bucket[k] ?? 0) + 1);

/**
 * The event row keeps the validated core verbatim in ai_config, including what has no Drizzle table
 * yet: stakeholders, budgetTotalMinor, and the day plan (event.durationDays / dailyStartTime / dailyEndTime).
 */
async function createEvent(tx: AppTransaction, organizationId: string, core: BlueprintCore): Promise<string> {
  const [ev] = await tx
    .insert(events)
    .values({
      organizationId,
      title: core.event.title,
      status: "draft",
      startDate: core.event.startDate,
      endDate: core.event.endDate,
      aiConfig: core as unknown as Record<string, unknown>,
      aiConfigVersion: BLUEPRINT_SCHEMA_VERSION,
    })
    .returning({ id: events.id });
  return ev!.id;
}

/** Order-independent JSON for hashing. Dates → ISO, BigInt/Decimal → string. */
function stable(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object" && v !== null && "toFixed" in v && typeof (v as { toString(): string }).toString === "function" && !Array.isArray(v))
    return Number((v as { toString(): string }).toString()); // Decimal
  if (Array.isArray(v)) return v.map(stable);
  if (typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}
export const fingerprint = (fields: object): string => createHash("sha256").update(JSON.stringify(stable(fields))).digest("hex");

/**
 * The rule for every Blueprint row: the AI may overwrite a row only if it still holds exactly what
 * the AI last wrote (hash match). Anything a person changed, completed or locked is preserved.
 */
function decide(existing: { aiFingerprint: string | null } | null, currentFields: object | null, locked = false) {
  if (!existing) return "create" as const;
  if (locked) return "preserve" as const;
  if (!existing.aiFingerprint || !currentFields || fingerprint(currentFields) !== existing.aiFingerprint) return "preserve" as const;
  return "update" as const;
}

/** numeric columns come back as strings; hash them as numbers (fingerprints stay stable across drivers). */
const num = (v: string | null) => (v == null ? null : Number(v));

const KPI_DATA_SOURCE_PRECEDENCE = ["survey", "ticket_sales", "system"] as const;

/**
 * Applies the rule to a metric's data sources. No sources, or a source the rule does not know, is
 * "no mapping": INVALID instead of a silent default.
 */
export function kpiDataSourceFor(metricKey: string, sources: readonly string[]): (typeof KPI_DATA_SOURCE_PRECEDENCE)[number] {
  const mapped = sources.map((src) => (Object.hasOwn(KPI_DATA_SOURCE, src) ? KPI_DATA_SOURCE[src as MetricDataSourceValue] : undefined));
  if (mapped.length === 0 || mapped.some((m) => m === undefined))
    throw new ProposalError("INVALID", `No data source mapping for metric ${metricKey}`);
  return KPI_DATA_SOURCE_PRECEDENCE.find((ds) => mapped.includes(ds))!;
}

async function applyOps(tx: AppTransaction, s: Scope, ops: ProposalOperation[], summary: ApplySummary) {
  const { organizationId: org, eventId } = s;
  const taskDeps: { key: string; deps: string[] }[] = [];
  const record = (entity: string, d: "create" | "update" | "preserve") =>
    bump(d === "create" ? summary.created : d === "update" ? summary.updated : summary.preserved, entity);

  for (const op of ops) {
    switch (op.entity) {
      case "task": {
        const t = op.data;
        const fields = {
          board: t.board, phase: t.phase, workstream: t.workstream, title: t.title, description: t.description,
          priority: t.priority, dueOffsetDays: t.dueOffsetDays, assigneeRole: t.assigneeRole,
        };
        const [existing] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.organizationId, org), eq(tasks.eventId, eventId), eq(tasks.blueprintKey, t.key)))
          .limit(1);
        const cur = existing && {
          board: existing.board, phase: existing.phase, workstream: existing.workstream, title: existing.title,
          description: existing.description, priority: existing.priority, dueOffsetDays: existing.dueOffsetDays,
          assigneeRole: existing.assigneeRole,
        };
        // Completed tasks are history; never rewritten.
        const d = decide(existing ?? null, cur ?? null, existing?.status === "DONE");
        const dueDate = s.start && t.dueOffsetDays != null ? addDays(s.start, t.dueOffsetDays) : null;
        if (d === "create")
          await tx.insert(tasks).values({
            organizationId: org, eventId, proposalId: s.proposalId, blueprintKey: t.key, position: t.position, isAiGenerated: true,
            ...fields, dueDate, aiFingerprint: fingerprint(fields),
          });
        if (d === "update")
          await tx
            .update(tasks)
            .set({ ...fields, dueDate, proposalId: s.proposalId, aiFingerprint: fingerprint(fields) })
            .where(and(eq(tasks.id, existing!.id), eq(tasks.organizationId, org)));
        if (d !== "preserve") taskDeps.push({ key: t.key, deps: t.dependsOnKeys });
        record("task", d);
        break;
      }
      case "kpi": {
        const k = op.data;
        const metric = METRIC_LIBRARY.find((m) => m.key === k.metricKey);
        if (!metric) throw new ProposalError("INVALID", `Unknown metric ${k.metricKey}`);
        const dataSource = kpiDataSourceFor(metric.key, metric.dataSources);
        const fields = {
          metricVersion: METRIC_DEFINITION_VERSION, target: k.target, objectiveIndex: k.objectiveIndex,
          rationale: k.targetBasis ? `${k.rationale} (Hedef dayanağı: ${k.targetBasis})` : k.rationale,
        };
        const [existing] = await tx
          .select()
          .from(eventKpis)
          .where(and(eq(eventKpis.organizationId, org), eq(eventKpis.eventId, eventId), eq(eventKpis.metricName, k.metricKey)))
          .limit(1);
        const cur = existing && {
          metricVersion: existing.metricVersion, target: num(existing.targetValue), objectiveIndex: existing.objectiveIndex, rationale: existing.rationale,
        };
        // Once the organizer activated or dropped a KPI, it is theirs.
        const d = decide(existing ?? null, cur ?? null, existing ? existing.status !== "PROPOSED" : false);
        const values = {
          dataSource, metricVersion: fields.metricVersion, targetValue: fields.target == null ? null : String(fields.target),
          objectiveIndex: fields.objectiveIndex, rationale: fields.rationale, aiFingerprint: fingerprint(fields),
        };
        if (d === "create")
          await tx.insert(eventKpis).values({ organizationId: org, eventId, metricName: k.metricKey, status: "PROPOSED", ...values });
        if (d === "update")
          await tx.update(eventKpis).set(values).where(and(eq(eventKpis.id, existing!.id), eq(eventKpis.organizationId, org)));
        record("kpi", d);
        break;
      }
      case "survey": {
        record("survey", await applySurvey(tx, s, op.data));
        break;
      }
      case "task_patch": {
        if (op.patch.assigneeId) {
          const [member] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, op.patch.assigneeId), eq(users.organizationId, org)))
            .limit(1);
          if (!member) throw new ProposalError("FORBIDDEN", "Assignee is not a member of this organization");
        }
        const target = and(eq(tasks.id, op.id), eq(tasks.eventId, eventId), eq(tasks.organizationId, org));
        const [current] = await tx.select({ status: tasks.status }).from(tasks).where(target).limit(1);
        if (!current) throw new ProposalError("CONFLICT", `Task ${op.id} no longer exists in this event`);
        // A completed task is history: the patch is not applied and is reported as preserved.
        if (current.status === "DONE") {
          record("task", "preserve");
          break;
        }
        const { title, priority, status, dueAt, assigneeId } = op.patch;
        await tx
          .update(tasks)
          .set({
            title,
            priority,
            status: status as "TODO" | "IN_PROGRESS" | "DONE" | undefined, // BLOCKED/CANCELLED refused before the transaction
            dueDate: dueAt,
            assignedTo: assigneeId,
            completedAt: status === "DONE" ? new Date() : undefined,
            updatedAt: new Date(),
          })
          .where(target);
        record("task", "update");
        break;
      }
      case "event":
        break; // handled before applyOps
      default:
        // Unsupported entities were refused before the transaction; reaching here is a bug.
        throw new ProposalError("INVALID", `Unsupported operation ${op.entity}`);
    }
  }

  // Second pass: dependency keys → task ids (includes tasks from earlier proposals).
  if (taskDeps.length) {
    const rows = await tx
      .select({ id: tasks.id, blueprintKey: tasks.blueprintKey })
      .from(tasks)
      .where(and(eq(tasks.organizationId, org), eq(tasks.eventId, eventId), isNotNull(tasks.blueprintKey)));
    const idByKey = new Map(rows.map((r) => [r.blueprintKey!, r.id]));
    for (const { key, deps } of taskDeps) {
      await tx
        .update(tasks)
        .set({ dependsOn: deps.map((d) => idByKey.get(d)).filter((x): x is string => !!x) })
        .where(and(eq(tasks.organizationId, org), eq(tasks.eventId, eventId), eq(tasks.blueprintKey, key)));
    }
  }
}

// --------------------------------------------------------------------------- surveys

type SurveyOp = Extract<ProposalOperation, { entity: "survey" }>["data"];

/** What a question looks like once stored (jsonb drops undefined keys). */
const persisted = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function questionRow(q: SurveyQuestion, position: number) {
  const { key, type, text, required, options, isSensitive, ...rest } = q;
  return persisted({
    questionKey: key, type, questionText: text, isMandatory: required, options: options ?? null,
    isSensitive: isSensitive ?? false, metadata: rest as Record<string, unknown>, position,
  });
}

/** The per-question part of the survey fingerprint, from stored column values. */
function questionProjection(r: {
  questionKey: string | null; type: string; questionText: string; isMandatory: boolean;
  options: unknown; isSensitive: boolean; metadata: unknown;
}) {
  return {
    key: r.questionKey, type: r.type, text: r.questionText, required: r.isMandatory,
    options: r.options, isSensitive: r.isSensitive, metadata: r.metadata,
  };
}

/**
 * Fingerprint of a survey AS STORED: header (title, intro, target_responses) + every question row in
 * position order (key, type, text, mandatory, options, sensitive, metadata). Read back from the
 * database, so jsonb normalisation can never make an untouched AI survey look edited.
 */
export async function persistedSurveyFingerprint(db: Db, organizationId: string, surveyId: string): Promise<string | null> {
  const [h] = await db
    .select({ title: surveys.title, intro: surveys.intro, targetResponses: surveys.targetResponses })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.organizationId, organizationId)))
    .limit(1);
  if (!h) return null;
  const rows = await db
    .select()
    .from(surveyQuestions)
    .where(and(eq(surveyQuestions.surveyId, surveyId), eq(surveyQuestions.organizationId, organizationId)))
    .orderBy(asc(surveyQuestions.position), asc(surveyQuestions.questionKey));
  return fingerprint({ title: h.title, intro: h.intro, targetResponses: h.targetResponses, questions: rows.map(questionProjection) });
}

async function writeQuestions(tx: AppTransaction, s: Scope, surveyId: string, sv: SurveyOp) {
  const rows = sv.questions.map((q, i) => questionRow(q, i));
  await tx.insert(surveyQuestions).values(
    rows.map((r) => ({
      ...r, organizationId: s.organizationId, eventId: s.eventId, surveyId, audience: sv.audience,
      aiFingerprint: fingerprint(questionProjection(r)),
    })),
  );
  const fp = await persistedSurveyFingerprint(tx, s.organizationId, surveyId);
  await tx.update(surveys).set({ aiFingerprint: fp }).where(and(eq(surveys.id, surveyId), eq(surveys.organizationId, s.organizationId)));
}

async function applySurvey(tx: AppTransaction, s: Scope, sv: SurveyOp): Promise<"create" | "update" | "preserve"> {
  const org = s.organizationId;
  const [existing] = await tx
    .select()
    .from(surveys)
    .where(and(eq(surveys.organizationId, org), eq(surveys.eventId, s.eventId), eq(surveys.blueprintKey, sv.key)))
    .orderBy(desc(surveys.version))
    .limit(1);

  if (existing && existing.status === "DRAFT") {
    const current = await persistedSurveyFingerprint(tx, org, existing.id);
    if (!existing.aiFingerprint || current !== existing.aiFingerprint) return "preserve"; // edited by a person
    // Untouched AI draft: replace header fields and questions.
    await tx
      .update(surveys)
      .set({ title: sv.title, intro: sv.intro, targetResponses: sv.targetResponses })
      .where(and(eq(surveys.id, existing.id), eq(surveys.organizationId, org)));
    await tx.delete(surveyQuestions).where(and(eq(surveyQuestions.surveyId, existing.id), eq(surveyQuestions.organizationId, org)));
    await writeQuestions(tx, s, existing.id, sv);
    return "update";
  }

  // No survey yet, or the latest one is OPEN/CLOSED: never edit it, start a new DRAFT version beside it.
  const [last] = await tx
    .select({ v: max(surveys.version) })
    .from(surveys)
    .where(and(eq(surveys.organizationId, org), eq(surveys.eventId, s.eventId), eq(surveys.audience, sv.audience)));
  const [created] = await tx
    .insert(surveys)
    .values({
      organizationId: org, eventId: s.eventId, audience: sv.audience, version: (last?.v ?? 0) + 1, status: "DRAFT",
      title: sv.title, intro: sv.intro, targetResponses: sv.targetResponses, isAiGenerated: true, blueprintKey: sv.key,
    })
    .returning({ id: surveys.id });
  await writeQuestions(tx, s, created!.id, sv);
  return "create";
}
