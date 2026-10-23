/**
 * Migration 0004 (Blueprint port): upgrade path from 0003, new columns/constraints, tenant isolation of the
 * new FKs, RLS and privileges of ai_generations, and parity of DB enums with the ORM-independent constants.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { aiGenerations, eventKpis, events, organizations, proposals, surveyQuestions, surveys, tasks } from "@/db/schema";
import { EVENT_PHASES, ORGANIZER_TYPES, SURVEY_AUDIENCES, TASK_BOARDS, TASK_PRIORITIES } from "@/lib/domain/enums";
import { SURVEY_QUESTION_TYPES } from "@/lib/metrics/question-bank";
import { ORG_A, ORG_B, U, migrationsUpTo, outcome, setupDb } from "./helpers";

const fp = (s: string) => createHash("sha256").update(s).digest("hex");
const inAWeek = () => new Date(Date.now() + 7 * 86_400_000);
const meta = { kind: "blueprint.tasks", title: "Görev planı", schemaVersion: "blueprint/v1" };
const rows = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;

// ---------------------------------------------------------------------------
// Upgrade path: a database migrated to 0003 that already holds data
// ---------------------------------------------------------------------------

describe("upgrade from 0003 with existing data", () => {
  it("applies only 0004, keeps existing rows, backfills required proposal fields and applies defaults", async () => {
    // A migrations folder that stops at 0003 (same files, journal truncated).
    const dir = migrationsUpTo(3);
    const pg = new PGlite({ extensions: { vector } });
    await pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
    await pg.exec(`set search_path to "$user", public, extensions;`);
    await migrate(drizzle({ client: pg }), { migrationsFolder: dir });

    // Data written under the 0003 schema (raw SQL: the TS schema now describes 0004).
    await pg.query("insert into auth.users (id, email) values ($1, 'legacy@example.com')", [U.ownerA]);
    await pg.exec(`
      insert into organizations (id, name) values ('${ORG_A}', 'Legacy Org');
      insert into users (id, organization_id, email, role) values ('${U.ownerA}', '${ORG_A}', 'legacy@example.com', 'owner');
      insert into events (id, organization_id, title) values ('e0000000-0000-4000-8000-000000000001', '${ORG_A}', 'Legacy event');
      insert into proposals (organization_id, event_id, payload, ai_fingerprint, expires_at)
        values ('${ORG_A}', 'e0000000-0000-4000-8000-000000000001', '{"tasks":[]}', '${fp("legacy")}', now() + interval '7 days');
      insert into tasks (organization_id, event_id, title, is_ai_generated) values ('${ORG_A}', 'e0000000-0000-4000-8000-000000000001', 'Legacy task', false);
      insert into event_kpis (organization_id, event_id, metric_name, target_value, data_source)
        values ('${ORG_A}', 'e0000000-0000-4000-8000-000000000001', 'nps', 40, 'survey');
      insert into survey_questions (organization_id, event_id, question_text, type)
        values ('${ORG_A}', 'e0000000-0000-4000-8000-000000000001', 'Memnun musunuz?', 'rating');`);

    // Up to 0004 only: 0005 (surveys) has its own upgrade test in surveys-0005.test.ts.
    await migrate(drizzle({ client: pg }), { migrationsFolder: migrationsUpTo(4) });

    const applied = await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(applied.rows[0]!.n).toBe(5);
    const p = await pg.query("select kind, title, schema_version, event_id is not null as has_event from proposals");
    expect(p.rows).toEqual([{ kind: "legacy.unknown", title: "Önceki sürümden öneri", schema_version: "pre-0004", has_event: true }]);
    const t = await pg.query("select board, phase, priority, depends_on, blueprint_key from tasks");
    expect(t.rows).toEqual([{ board: "PLANNING", phase: "PLAN", priority: "MEDIUM", depends_on: [], blueprint_key: null }]);
    const k = await pg.query("select status, metric_version, target_value from event_kpis");
    expect(k.rows).toEqual([{ status: "PROPOSED", metric_version: 1, target_value: "40.0000" }]);
    const q = await pg.query("select audience, metadata, is_sensitive, type from survey_questions");
    expect(q.rows).toEqual([{ audience: "ATTENDEE", metadata: {}, is_sensitive: false, type: "rating" }]);
    const o = await pg.query("select organizer_type from organizations");
    expect(o.rows).toEqual([{ organizer_type: "OTHER" }]);
  });
});

// ---------------------------------------------------------------------------
// Fresh database at 0004
// ---------------------------------------------------------------------------

let ctx: Awaited<ReturnType<typeof setupDb>>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  ctx = await setupDb();
  const { db } = ctx;
  for (const [org, tag, user] of [[ORG_A, "A", U.ownerA], [ORG_B, "B", U.ownerB]] as const) {
    const [ev] = await db.insert(events).values({ organizationId: org, title: `Event ${tag}` }).returning();
    ids[`event${tag}`] = ev!.id;
    const [g] = await db.insert(aiGenerations).values({
      organizationId: org, requestedBy: user, kind: "blueprint.core", prompt: "p", schemaVersion: "blueprint/v1",
      provider: "anthropic", model: "m", temperature: "0",
    }).returning();
    ids[`generation${tag}`] = g!.id;
  }
});

describe("events.ai_config", () => {
  it("stores an object together with its version", async () => {
    expect(await outcome(ctx.db.update(events).set({ aiConfig: { schemaVersion: "blueprint/v1" }, aiConfigVersion: "blueprint/v1" })
      .where(eq(events.id, ids.eventA!)))).toBe("ok");
  });
  it("rejects a config without a version, or a non-object config", async () => {
    expect(await outcome(ctx.db.update(events).set({ aiConfigVersion: null }).where(eq(events.id, ids.eventA!)))).toMatch(/events_ai_config_versioned/);
    expect(await outcome(ctx.db.execute(sql`update events set ai_config = '[1]'::jsonb where id = ${ids.eventA!}`))).toMatch(/events_ai_config_is_object/);
  });
});

describe("organizations.organizer_type", () => {
  it("defaults to OTHER and is not client-writable", async () => {
    const [o] = await ctx.db.select({ t: organizations.organizerType }).from(organizations).where(eq(organizations.id, ORG_A));
    expect(o!.t).toBe("OTHER");
    // 0006: organizations are not browser-writable at all (no UPDATE privilege)
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(organizations).set({ organizerType: "MUNICIPALITY" }).returning()))).toMatch(/permission denied/);
  });
});

describe("proposals (0004 columns)", () => {
  it("a blueprint.core proposal may exist before its event (event_id null)", async () => {
    expect(await outcome(ctx.db.insert(proposals).values({ organizationId: ORG_A, eventId: null, generationId: ids.generationA!, requestedBy: U.ownerA,
      payload: { operations: [] }, aiFingerprint: fp("core"), expiresAt: inAWeek(), kind: "blueprint.core", title: "Profil", schemaVersion: "blueprint/v1" }))).toBe("ok");
  });
  it("cross-tenant generation, requester or event are rejected even for server code", async () => {
    const base = { organizationId: ORG_A, payload: {}, aiFingerprint: fp("x"), expiresAt: inAWeek(), ...meta };
    expect(await outcome(ctx.db.insert(proposals).values({ ...base, eventId: ids.eventA!, generationId: ids.generationB! }))).toMatch(/proposals_generation_same_org_fk/);
    expect(await outcome(ctx.db.insert(proposals).values({ ...base, eventId: ids.eventA!, requestedBy: U.ownerB }))).toMatch(/proposals_requested_by_same_org_fk/);
    expect(await outcome(ctx.db.insert(proposals).values({ ...base, eventId: ids.eventB! }))).toMatch(/proposals_event_same_org_fk/);
  });
  it("kind needs a literal dot; title and version must not be blank", async () => {
    const base = { organizationId: ORG_A, eventId: ids.eventA!, payload: {}, aiFingerprint: fp("k"), expiresAt: inAWeek(), title: "t", schemaVersion: "v" };
    expect(await outcome(ctx.db.insert(proposals).values({ ...base, kind: "blueprintXtasks" }))).toMatch(/proposals_kind_format/);
    expect(await outcome(ctx.db.insert(proposals).values({ ...base, kind: "blueprint" }))).toMatch(/proposals_kind_format/);
    expect(await outcome(ctx.db.insert(proposals).values({ ...base, kind: "copilot.update_task", title: " " }))).toMatch(/proposals_title_not_blank/);
  });
  it("EXPIRED is a storable status; applied_ops must be an array", async () => {
    const [p] = await ctx.db.insert(proposals).values({ organizationId: ORG_A, eventId: ids.eventA!, payload: {}, aiFingerprint: fp("e"),
      expiresAt: inAWeek(), ...meta }).returning();
    expect(await outcome(ctx.db.update(proposals).set({ status: "EXPIRED" }).where(eq(proposals.id, p!.id)))).toBe("ok");
    expect(await outcome(ctx.db.execute(sql`update proposals set applied_ops = '{"a":1}'::jsonb where id = ${p!.id}`))).toMatch(/proposals_applied_ops_is_array/);
  });
  it("clients still cannot write proposals (0003 privileges cover the new columns)", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(proposals).set({ title: "x" })))).toMatch(/permission denied/);
  });
});

describe("ai_generations", () => {
  it("each organization reads only its own generations; anon and outsiders read none", async () => {
    const seen = async (u: string) => (await ctx.as(u, (tx) => tx.select({ o: aiGenerations.organizationId }).from(aiGenerations))).map((r) => r.o);
    expect(new Set(await seen(U.ownerA))).toEqual(new Set([ORG_A]));
    expect(new Set(await seen(U.ownerB))).toEqual(new Set([ORG_B]));
    expect(await seen(U.noProfile)).toEqual([]);
    const anon = await ctx.pg.transaction(async (tx) => {
      await tx.exec("set local role anon");
      return tx.query<{ n: number }>("select count(*)::int as n from ai_generations");
    });
    expect(anon.rows[0]!.n).toBe(0);
  });
  it("clients cannot insert, update or delete (server-only)", async () => {
    for (const a of [
      ctx.as(U.ownerA, (tx) => tx.insert(aiGenerations).values({ organizationId: ORG_A, kind: "blueprint.core", prompt: "p", schemaVersion: "v",
        provider: "x", model: "m", temperature: "0" })),
      ctx.as(U.ownerA, (tx) => tx.update(aiGenerations).set({ status: "APPLIED" })),
      ctx.as(U.ownerA, (tx) => tx.delete(aiGenerations)),
    ]) expect(await outcome(a)).toMatch(/permission denied/);
  });
  it("cross-tenant event or requester are rejected", async () => {
    const base = { organizationId: ORG_A, kind: "blueprint.tasks", prompt: "p", schemaVersion: "v", provider: "x", model: "m", temperature: "0" };
    expect(await outcome(ctx.db.insert(aiGenerations).values({ ...base, eventId: ids.eventB! }))).toMatch(/ai_generations_event_same_org_fk/);
    expect(await outcome(ctx.db.insert(aiGenerations).values({ ...base, requestedBy: U.ownerB }))).toMatch(/ai_generations_requested_by_same_org_fk/);
  });
});

describe("column-scoped ON DELETE SET NULL keeps audit rows and their organization", () => {
  it("deleting an event, a generation or a person clears only the reference", async () => {
    const [ev] = await ctx.db.insert(events).values({ organizationId: ORG_B, title: "Temp" }).returning();
    const [g] = await ctx.db.insert(aiGenerations).values({ organizationId: ORG_B, eventId: ev!.id, requestedBy: U.ownerB, kind: "blueprint.kpis",
      prompt: "p", schemaVersion: "v", provider: "x", model: "m", temperature: "0" }).returning();
    const [p] = await ctx.db.insert(proposals).values({ organizationId: ORG_B, eventId: null, generationId: g!.id, requestedBy: U.ownerB,
      payload: {}, aiFingerprint: fp("d"), expiresAt: inAWeek(), ...meta }).returning();

    await ctx.db.delete(events).where(eq(events.id, ev!.id));
    expect((await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, g!.id)))[0]).toMatchObject({ eventId: null, organizationId: ORG_B });

    await ctx.db.delete(aiGenerations).where(eq(aiGenerations.id, g!.id));
    expect((await ctx.db.select().from(proposals).where(eq(proposals.id, p!.id)))[0]).toMatchObject({ generationId: null, organizationId: ORG_B });

    await ctx.pg.query("delete from auth.users where id = $1", [U.ownerB]);
    expect((await ctx.db.select().from(proposals).where(eq(proposals.id, p!.id)))[0]).toMatchObject({ requestedBy: null, organizationId: ORG_B });
    expect(await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.requestedBy, U.ownerB))).toEqual([]);
  });
});

describe("tasks (0004 columns)", () => {
  const aiTask = (eventKey: "eventA" | "eventB", org: string, key: string) =>
    ctx.db.insert(tasks).values({ organizationId: org, eventId: ids[eventKey]!, title: key, isAiGenerated: true, blueprintKey: key,
      board: "MEASUREMENT", phase: "PREPARE", priority: "HIGH", dueOffsetDays: -21, dueDate: "2027-04-01", workstream: "data_collection",
      assigneeRole: "Ölçüm sorumlusu", position: "m0000", aiFingerprint: fp(key) }).returning();

  it("a Blueprint key is unique per event (regeneration updates instead of duplicating)", async () => {
    expect(await outcome(aiTask("eventA", ORG_A, "venue_contract"))).toBe(1);
    expect(await outcome(aiTask("eventA", ORG_A, "venue_contract"))).toMatch(/tasks_event_blueprint_key_uq/);
  });
  it("only AI tasks carry a Blueprint key; formats and offset range are enforced", async () => {
    expect(await outcome(ctx.db.insert(tasks).values({ organizationId: ORG_A, eventId: ids.eventA!, title: "m", blueprintKey: "manual" })))
      .toMatch(/tasks_blueprint_key_only_for_ai/);
    expect(await outcome(ctx.db.insert(tasks).values({ organizationId: ORG_A, eventId: ids.eventA!, title: "m", isAiGenerated: true, blueprintKey: "Bad Key" })))
      .toMatch(/tasks_blueprint_key_format/);
    expect(await outcome(ctx.db.insert(tasks).values({ organizationId: ORG_A, eventId: ids.eventA!, title: "m", dueOffsetDays: 999 })))
      .toMatch(/tasks_due_offset_range/);
  });
  it("clients still change status only — not the new planning columns", async () => {
    const [t] = await ctx.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.blueprintKey, "venue_contract"));
    expect(await outcome(ctx.as(U.staffA, (tx) => tx.update(tasks).set({ status: "IN_PROGRESS" }).where(eq(tasks.id, t!.id)).returning({ id: tasks.id })))).toBe(1);
    for (const patch of [{ priority: "LOW" as const }, { dueDate: "2027-01-01" }, { blueprintKey: "x_y" }, { completedAt: new Date() }])
      expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(tasks).set(patch).where(eq(tasks.id, t!.id))))).toMatch(/permission denied/);
  });
});

describe("event_kpis (0004 columns)", () => {
  it("a KPI may have no target; fingerprint must be sha256 hex", async () => {
    expect(await outcome(ctx.db.insert(eventKpis).values({ organizationId: ORG_A, eventId: ids.eventA!, metricName: "overall_satisfaction",
      targetValue: null, dataSource: "survey", objectiveIndex: 0, rationale: "r", aiFingerprint: fp("kpi") }))).toBe("ok");
    expect(await outcome(ctx.db.insert(eventKpis).values({ organizationId: ORG_A, eventId: ids.eventA!, metricName: "nps",
      dataSource: "survey", aiFingerprint: "not-hex".padEnd(64, "z") }))).toMatch(/event_kpis_ai_fingerprint_hex/);
  });
  it("clients cannot activate or retarget KPIs", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(eventKpis).set({ status: "ACTIVE" })))).toMatch(/permission denied/);
  });
});

describe("survey_questions (0004 metadata)", () => {
  // Since 0005 every question belongs to a survey header of the same organization, event and audience.
  const surveyFor: Record<string, string> = {};
  beforeAll(async () => {
    for (const audience of ["ATTENDEE", "LOCAL_BUSINESS"] as const) {
      const [s] = await ctx.db.insert(surveys).values({ organizationId: ORG_A, eventId: ids.eventA!, audience, title: "Anket" }).returning();
      surveyFor[audience] = s!.id;
    }
  });
  const q = (over: Partial<typeof surveyQuestions.$inferInsert>) =>
    ctx.db.insert(surveyQuestions).values({ organizationId: ORG_A, eventId: ids.eventA!, questionText: "Soru", type: "LIKERT_5",
      surveyId: surveyFor[over.audience ?? "ATTENDEE"]!, ...over });

  it("stores question-bank answer formats with key, audience, options and metadata", async () => {
    expect(await outcome(q({ questionKey: "q_spend_food", type: "CURRENCY_TRY", audience: "ATTENDEE",
      metadata: { measures: ["mean_spend_per_visitor_day"], spendCategory: "FOOD_BEVERAGE", spendBasis: "party_total_stay" } }))).toBe("ok");
    expect(await outcome(q({ questionKey: "q_main_reason", type: "SINGLE_CHOICE", options: [{ value: "event", label: "Bu etkinlik" }, { value: "other", label: "Başka" }] }))).toBe("ok");
  });
  it("a key is unique per survey (0005: was per event and audience); the same key may exist for another audience", async () => {
    expect(await outcome(q({ questionKey: "q_spend_food", type: "CURRENCY_TRY" }))).toMatch(/survey_questions_survey_key_uq/);
    expect(await outcome(q({ questionKey: "q_spend_food", type: "CURRENCY_TRY", audience: "LOCAL_BUSINESS" }))).toBe("ok");
  });
  it("choice questions need options; keys, options and metadata are well-formed", async () => {
    expect(await outcome(q({ questionKey: "x_pick", type: "MULTI_CHOICE" }))).toMatch(/survey_questions_choice_has_options/);
    expect(await outcome(q({ questionKey: "Q-bad" }))).toMatch(/survey_questions_key_format/);
    expect(await outcome(ctx.db.execute(sql`update survey_questions set metadata = '[]'::jsonb where question_key = 'q_spend_food'`)))
      .toMatch(/survey_questions_metadata_is_object/);
  });
  it("clients cannot write questions", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(surveyQuestions).set({ isSensitive: true })))).toMatch(/permission denied/);
  });
});

describe("DB enums match the ORM-independent constants", () => {
  const values = async (name: string) =>
    rows(await ctx.db.execute(sql`select e.enumlabel as v from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = ${name} order by e.enumsortorder`))
      .map((r) => r.v);
  it.each([
    ["organizer_type", ORGANIZER_TYPES],
    ["event_phase", EVENT_PHASES],
    ["task_board", TASK_BOARDS],
    ["task_priority", TASK_PRIORITIES],
    ["survey_audience", SURVEY_AUDIENCES],
  ] as const)("%s", async (name, expected) => {
    expect(await values(name)).toEqual([...expected]);
  });
  it("survey_question_type contains every question-bank answer format", async () => {
    expect(await values("survey_question_type")).toEqual(["text", "rating", "boolean", ...SURVEY_QUESTION_TYPES]);
  });
});
