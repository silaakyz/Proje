/** Planning & AI Blueprint tables: tenant isolation, column-level write limits, cross-tenant FKs. */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { events, eventKpis, proposals, surveyQuestions, surveys, tasks, users } from "@/db/schema";
import { ORG_A, ORG_B, U, outcome, setupDb } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupDb>>;
const ids: Record<string, string> = {};
const fp = (s: string) => createHash("sha256").update(s).digest("hex");
const inAWeek = () => new Date(Date.now() + 7 * 86_400_000);
/** Required since migration 0004. */
const proposalMeta = { kind: "blueprint.tasks", title: "Test proposal", schemaVersion: "blueprint/v1" };

beforeAll(async () => {
  ctx = await setupDb();
  const { db } = ctx;
  for (const [org, tag] of [[ORG_A, "A"], [ORG_B, "B"]] as const) {
    const [ev] = await db.insert(events).values({ organizationId: org, title: `Event ${tag}` }).returning();
    ids[`event${tag}`] = ev!.id;
    const [p] = await db.insert(proposals).values({ organizationId: org, eventId: ev!.id, payload: { tasks: [] }, aiFingerprint: fp(tag), expiresAt: inAWeek(), ...proposalMeta }).returning();
    ids[`proposal${tag}`] = p!.id;
    const [t] = await db.insert(tasks).values({ organizationId: org, eventId: ev!.id, proposalId: p!.id, title: `Task ${tag}`, isAiGenerated: true,
      aiFingerprint: fp(`task${tag}`), assignedTo: tag === "A" ? U.staffA : U.ownerB }).returning();
    ids[`task${tag}`] = t!.id;
    await db.insert(eventKpis).values({ organizationId: org, eventId: ev!.id, metricName: "nps", targetValue: "40", dataSource: "survey" });
    const [sv] = await db.insert(surveys).values({ organizationId: org, eventId: ev!.id, audience: "ATTENDEE", title: "Anket" }).returning(); // required since 0005
    ids[`survey${tag}`] = sv!.id;
    await db.insert(surveyQuestions).values({ organizationId: org, eventId: ev!.id, surveyId: sv!.id, questionText: "Memnun kaldınız mı?", type: "rating", isMandatory: true });
  }
});

describe("SELECT: own organization only", () => {
  const tables = { proposals, tasks, eventKpis, surveyQuestions };
  it.each(Object.keys(tables))("%s", async (name) => {
    const t = tables[name as keyof typeof tables] as typeof tasks;
    const orgsSeenBy = async (u: string) => [...new Set((await ctx.as(u, (tx) => tx.select({ o: t.organizationId }).from(t))).map((r) => r.o))];
    expect(await orgsSeenBy(U.staffA)).toEqual([ORG_A]);
    expect(await orgsSeenBy(U.ownerB)).toEqual([ORG_B]);
    expect(await orgsSeenBy(U.noProfile)).toEqual([]);
  });
});

describe("tasks: clients may change status only", () => {
  it("status of an own-organization task: allowed", async () => {
    expect(await outcome(ctx.as(U.staffA, (tx) => tx.update(tasks).set({ status: "DONE" }).where(eq(tasks.id, ids.taskA!)).returning({ id: tasks.id })))).toBe(1);
  });
  it("any other column: rejected by column privileges", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(tasks).set({ title: "renamed" }).where(eq(tasks.id, ids.taskA!))))).toMatch(/permission denied/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(tasks).set({ assignedTo: U.ownerA }).where(eq(tasks.id, ids.taskA!))))).toMatch(/permission denied/);
  });
  it("another tenant's task: zero rows", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(tasks).set({ status: "DONE" }).where(eq(tasks.id, ids.taskB!)).returning({ id: tasks.id })))).toBe(0);
  });
  it("insert and delete: rejected", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.insert(tasks).values({ organizationId: ORG_A, eventId: ids.eventA!, title: "x" })))).toMatch(/permission denied/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.delete(tasks)))).toMatch(/permission denied/);
  });
});

describe("proposals, event_kpis, survey_questions: server-only writes", () => {
  it("clients cannot insert, update or delete any of them", async () => {
    const attempts = [
      ctx.as(U.ownerA, (tx) => tx.update(proposals).set({ status: "APPROVED", decidedAt: new Date() }).where(eq(proposals.id, ids.proposalA!))),
      ctx.as(U.ownerA, (tx) => tx.insert(proposals).values({ organizationId: ORG_A, eventId: ids.eventA!, payload: {}, aiFingerprint: fp("x"), expiresAt: inAWeek(), ...proposalMeta })),
      ctx.as(U.ownerA, (tx) => tx.update(eventKpis).set({ actualValue: "99" })),
      ctx.as(U.ownerA, (tx) => tx.insert(eventKpis).values({ organizationId: ORG_A, eventId: ids.eventA!, metricName: "x_metric", targetValue: "1", dataSource: "system" })),
      ctx.as(U.ownerA, (tx) => tx.update(surveyQuestions).set({ isMandatory: false })),
      ctx.as(U.ownerA, (tx) => tx.delete(surveyQuestions)),
    ];
    for (const a of attempts) expect(await outcome(a)).toMatch(/permission denied/);
  });
});

describe("cross-tenant references are impossible, even for server code", () => {
  it("assigning a task to another organization's user", async () => {
    expect(await outcome(ctx.db.update(tasks).set({ assignedTo: U.ownerB }).where(eq(tasks.id, ids.taskA!)))).toMatch(/tasks_assignee_same_org_fk/);
  });
  it("linking a task to another organization's proposal", async () => {
    expect(await outcome(ctx.db.update(tasks).set({ proposalId: ids.proposalB! }).where(eq(tasks.id, ids.taskA!)))).toMatch(/tasks_proposal_same_org_fk/);
  });
  it("a KPI, survey question or proposal on another organization's event", async () => {
    expect(await outcome(ctx.db.insert(eventKpis).values({ organizationId: ORG_A, eventId: ids.eventB!, metricName: "nps2", targetValue: "1", dataSource: "survey" })))
      .toMatch(/event_kpis_event_same_org_fk/);
    expect(await outcome(ctx.db.insert(surveyQuestions).values({ organizationId: ORG_A, eventId: ids.eventB!, surveyId: ids.surveyB!, questionText: "q", type: "text" })))
      .toMatch(/survey_questions_(event_same_org|survey_same_scope)_fk/);
    expect(await outcome(ctx.db.insert(proposals).values({ organizationId: ORG_A, eventId: ids.eventB!, payload: {}, aiFingerprint: fp("y"), expiresAt: inAWeek(), ...proposalMeta })))
      .toMatch(/proposals_event_same_org_fk/);
  });
  it("a decision recorded by another organization's user", async () => {
    expect(await outcome(ctx.db.update(proposals).set({ status: "APPROVED", decidedBy: U.ownerB, decidedAt: new Date() }).where(eq(proposals.id, ids.proposalA!))))
      .toMatch(/proposals_decided_by_same_org_fk/);
  });
});

describe("integrity rules", () => {
  it("proposal state machine fields are consistent", async () => {
    expect(await outcome(ctx.db.update(proposals).set({ status: "APPROVED" }).where(eq(proposals.id, ids.proposalA!)))).toMatch(/proposals_decision_recorded/);
    expect(await outcome(ctx.db.update(proposals).set({ status: "FAILED" }).where(eq(proposals.id, ids.proposalA!)))).toMatch(/proposals_failed_has_reason/);
    expect(await outcome(ctx.db.update(proposals).set({ aiFingerprint: "not-a-hash" }).where(eq(proposals.id, ids.proposalA!)))).toMatch(/proposals_fingerprint_hex/);
    expect(await outcome(ctx.db.update(proposals).set({ status: "APPROVED", decidedBy: U.ownerA, decidedAt: new Date() }).where(eq(proposals.id, ids.proposalA!)))).toBe("ok");
  });
  it("a human-created task cannot carry an AI fingerprint; KPI names are machine keys", async () => {
    expect(await outcome(ctx.db.insert(tasks).values({ organizationId: ORG_A, eventId: ids.eventA!, title: "manual", aiFingerprint: fp("m") })))
      .toMatch(/tasks_ai_fingerprint_only_for_ai/);
    expect(await outcome(ctx.db.insert(eventKpis).values({ organizationId: ORG_A, eventId: ids.eventA!, metricName: "Net Impact!", targetValue: "1", dataSource: "system" })))
      .toMatch(/event_kpis_metric_name_format/);
  });
  it("deleting a person clears only their references; tasks, organization and the audit timestamp survive", async () => {
    await ctx.pg.query("delete from auth.users where id = $1", [U.staffA]); // cascades to public.users
    const [t] = await ctx.db.select().from(tasks).where(eq(tasks.id, ids.taskA!));
    expect(t).toMatchObject({ assignedTo: null, organizationId: ORG_A });
    await ctx.pg.query("delete from auth.users where id = $1", [U.ownerA]);
    const [p] = await ctx.db.select().from(proposals).where(eq(proposals.id, ids.proposalA!));
    expect(p).toMatchObject({ status: "APPROVED", decidedBy: null, organizationId: ORG_A });
    expect(p!.decidedAt).toBeInstanceOf(Date);
    expect(await ctx.db.select().from(users).where(eq(users.organizationId, ORG_A))).toEqual([]);
  });
  it("deleting a proposal keeps its tasks and clears the link", async () => {
    await ctx.db.delete(proposals).where(eq(proposals.id, ids.proposalB!));
    const [t] = await ctx.db.select().from(tasks).where(eq(tasks.id, ids.taskB!));
    expect(t).toMatchObject({ proposalId: null, organizationId: ORG_B });
  });
  it("every table in public has RLS", async () => {
    const r = await ctx.db.execute(sql`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect((r as unknown as { rows: unknown[] }).rows).toEqual([]);
  });
});
