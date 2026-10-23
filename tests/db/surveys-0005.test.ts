/**
 * Migration 0005 (surveys header): upgrade path from 0004 with existing survey_questions (backfill,
 * nothing lost), constraints, tenant FKs, RLS and privileges of the new table.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { events, surveyQuestions, surveys } from "@/db/schema";
import { ORG_A, ORG_B, U, migrationsUpTo, outcome, setupDb } from "./helpers";

const fp = (s: string) => createHash("sha256").update(s).digest("hex");

describe("upgrade from 0004 with existing survey questions", () => {
  it("creates one v1 DRAFT header per (organization, event, audience) and keeps every question intact", async () => {
    const pg = new PGlite({ extensions: { vector } });
    await pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
    await pg.exec(`set search_path to "$user", public, extensions;`);
    await migrate(drizzle({ client: pg }), { migrationsFolder: migrationsUpTo(4) });

    const E1 = "e0000000-0000-4000-8000-000000000001", E2 = "e0000000-0000-4000-8000-000000000002", EB = "e0000000-0000-4000-8000-0000000000b1";
    await pg.exec(`
      insert into organizations (id, name) values ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
      insert into events (id, organization_id, title) values ('${E1}', '${ORG_A}', 'A1'), ('${E2}', '${ORG_A}', 'A2'), ('${EB}', '${ORG_B}', 'B1');
      insert into survey_questions (organization_id, event_id, question_text, type, is_mandatory, position, audience, question_key, options, metadata, is_sensitive, ai_fingerprint) values
        ('${ORG_A}', '${E1}', 'Tavsiye eder misiniz?', 'NPS_0_10', true, 0, 'ATTENDEE', 'q_nps', null, '{"measures":["nps"],"origin":"BANK"}', false, '${fp("q1")}'),
        ('${ORG_A}', '${E1}', 'Neden geldiniz?', 'SINGLE_CHOICE', false, 1, 'ATTENDEE', 'q_main_reason', '[{"value":"a","label":"A"},{"value":"b","label":"B"}]', '{}', false, null),
        ('${ORG_A}', '${E1}', 'Ciro değişimi?', 'LIKERT_5', true, 0, 'LOCAL_BUSINESS', 'q_turnover', null, '{}', false, null),
        ('${ORG_A}', '${E2}', 'Elle eklenen soru', 'text', false, 0, 'ATTENDEE', null, null, '{}', true, null),
        ('${ORG_B}', '${EB}', 'B sorusu', 'rating', true, 0, 'ATTENDEE', 'q_b', null, '{}', false, null);`);
    const cols = "id, organization_id, event_id, question_text, type, is_mandatory, position, audience, question_key, options, metadata, is_sensitive, ai_fingerprint, created_at";
    const before = (await pg.query(`select ${cols} from survey_questions order by id`)).rows;

    await migrate(drizzle({ client: pg }), { migrationsFolder: migrationsUpTo(5) } /* up to 0005 only; 0006 has its own upgrade test */);

    expect((await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(6);
    // Every question survived unchanged (all pre-0005 columns).
    expect((await pg.query(`select ${cols} from survey_questions order by id`)).rows).toEqual(before);

    const headers = (await pg.query<Record<string, unknown>>(
      `select organization_id, event_id, audience, version, status, title, intro, target_responses, is_ai_generated, blueprint_key, ai_fingerprint
       from surveys order by organization_id, event_id, audience`)).rows;
    expect(headers).toEqual([
      { organization_id: ORG_A, event_id: E1, audience: "ATTENDEE", version: 1, status: "DRAFT", title: "Anket", intro: null, target_responses: null, is_ai_generated: false, blueprint_key: null, ai_fingerprint: null },
      { organization_id: ORG_A, event_id: E1, audience: "LOCAL_BUSINESS", version: 1, status: "DRAFT", title: "Anket", intro: null, target_responses: null, is_ai_generated: false, blueprint_key: null, ai_fingerprint: null },
      { organization_id: ORG_A, event_id: E2, audience: "ATTENDEE", version: 1, status: "DRAFT", title: "Anket", intro: null, target_responses: null, is_ai_generated: false, blueprint_key: null, ai_fingerprint: null },
      { organization_id: ORG_B, event_id: EB, audience: "ATTENDEE", version: 1, status: "DRAFT", title: "Anket", intro: null, target_responses: null, is_ai_generated: false, blueprint_key: null, ai_fingerprint: null },
    ]);
    // Each question points at the header of its own organization, event and audience.
    const mismatched = await pg.query(`select q.id from survey_questions q join surveys s on s.id = q.survey_id
      where s.organization_id <> q.organization_id or s.event_id <> q.event_id or s.audience <> q.audience`);
    expect(mismatched.rows).toEqual([]);
    const perSurvey = (await pg.query<{ n: number }>(`select count(*)::int as n from survey_questions group by survey_id order by 1`)).rows.map((r) => r.n);
    expect(perSurvey).toEqual([1, 1, 1, 2]);
    expect((await pg.query(`select is_nullable from information_schema.columns where table_name = 'survey_questions' and column_name = 'survey_id'`)).rows)
      .toEqual([{ is_nullable: "NO" }]);
  });

  it("an empty survey_questions table upgrades cleanly (no headers invented)", async () => {
    const pg = new PGlite({ extensions: { vector } });
    await pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
    await pg.exec(`set search_path to "$user", public, extensions;`);
    await migrate(drizzle({ client: pg }), { migrationsFolder: migrationsUpTo(4) });
    await migrate(drizzle({ client: pg }), { migrationsFolder: migrationsUpTo(5) });
    expect((await pg.query("select * from surveys")).rows).toEqual([]);
  });
});

let ctx: Awaited<ReturnType<typeof setupDb>>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  ctx = await setupDb();
  for (const [org, tag] of [[ORG_A, "A"], [ORG_B, "B"]] as const) {
    const [ev] = await ctx.db.insert(events).values({ organizationId: org, title: `Event ${tag}` }).returning();
    ids[`event${tag}`] = ev!.id;
    const [s] = await ctx.db.insert(surveys).values({ organizationId: org, eventId: ev!.id, audience: "ATTENDEE", title: `Anket ${tag}`, intro: "Giriş" }).returning();
    ids[`survey${tag}`] = s!.id;
  }
}, 60_000);

describe("surveys: constraints", () => {
  const base = () => ({ organizationId: ORG_A, eventId: ids.eventA!, audience: "SPONSOR" as const, title: "T" });
  it("rejects blank titles, non-positive versions/targets, bad keys and AI-only fields on human rows", async () => {
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), title: "  " }))).toMatch(/surveys_title_not_blank/);
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), version: 0 }))).toMatch(/surveys_version_positive/);
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), targetResponses: 0 }))).toMatch(/surveys_target_responses_positive/);
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), blueprintKey: "survey_sponsor" }))).toMatch(/surveys_blueprint_key_only_for_ai/);
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), isAiGenerated: true, blueprintKey: "Survey X" }))).toMatch(/surveys_blueprint_key_format/);
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), aiFingerprint: fp("x") }))).toMatch(/surveys_ai_fingerprint_only_for_ai/);
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), isAiGenerated: true, aiFingerprint: "z".repeat(64) }))).toMatch(/surveys_ai_fingerprint_hex/);
  });
  it("one row per (event, audience, version)", async () => {
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), audience: "ATTENDEE" }))).toMatch(/surveys_event_audience_version_uq/);
    expect(await outcome(ctx.db.insert(surveys).values({ ...base(), audience: "ATTENDEE", version: 2 }))).toBe("ok");
  });
});

describe("surveys: tenant safety", () => {
  it("a survey cannot point at another organization's event", async () => {
    expect(await outcome(ctx.db.insert(surveys).values({ organizationId: ORG_A, eventId: ids.eventB!, audience: "ATTENDEE", title: "x", version: 9 })))
      .toMatch(/surveys_event_same_org_fk/);
  });
  it("a question must match its survey's organization, event and audience", async () => {
    const q = { questionText: "Soru", type: "text" as const };
    expect(await outcome(ctx.db.insert(surveyQuestions).values({ ...q, organizationId: ORG_A, eventId: ids.eventA!, surveyId: ids.surveyB! })))
      .toMatch(/survey_questions_survey_same_scope_fk/);
    expect(await outcome(ctx.db.insert(surveyQuestions).values({ ...q, organizationId: ORG_A, eventId: ids.eventA!, surveyId: ids.surveyA!, audience: "SPONSOR" })))
      .toMatch(/survey_questions_survey_same_scope_fk/);
    expect(await outcome(ctx.db.insert(surveyQuestions).values({ ...q, organizationId: ORG_A, eventId: ids.eventA!, surveyId: ids.surveyA!, questionKey: "q_ok" }))).toBe("ok");
  });
  it("members read only their organization's surveys; nobody without a profile reads any", async () => {
    const seen = (u: string) => ctx.as(u, (tx) => tx.select({ o: surveys.organizationId }).from(surveys));
    expect(new Set((await seen(U.ownerA)).map((r) => r.o))).toEqual(new Set([ORG_A]));
    expect(new Set((await seen(U.staffA)).map((r) => r.o))).toEqual(new Set([ORG_A]));
    expect(new Set((await seen(U.ownerB)).map((r) => r.o))).toEqual(new Set([ORG_B]));
    expect(await seen(U.noProfile)).toEqual([]);
  });
  it("clients cannot insert, update or delete surveys", async () => {
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.insert(surveys).values({ organizationId: ORG_A, eventId: ids.eventA!, audience: "RESIDENT", title: "x" }))))
      .toMatch(/permission denied/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.update(surveys).set({ status: "OPEN" }).where(eq(surveys.id, ids.surveyA!))))).toMatch(/permission denied/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.delete(surveys).where(eq(surveys.id, ids.surveyA!))))).toMatch(/permission denied/);
  });
  it("deleting an event removes its surveys and their questions", async () => {
    const [ev] = await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Silinecek" }).returning();
    const [s] = await ctx.db.insert(surveys).values({ organizationId: ORG_A, eventId: ev!.id, audience: "ATTENDEE", title: "x" }).returning();
    await ctx.db.insert(surveyQuestions).values({ organizationId: ORG_A, eventId: ev!.id, surveyId: s!.id, questionText: "Soru", type: "text" });
    await ctx.db.delete(events).where(eq(events.id, ev!.id));
    expect(await ctx.db.select().from(surveys).where(eq(surveys.id, s!.id))).toEqual([]);
    expect(await ctx.db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, s!.id))).toEqual([]);
  });
  it("survey_status enum is DRAFT/OPEN/CLOSED", async () => {
    const r = await ctx.db.execute(sql`select e.enumlabel as v from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'survey_status' order by e.enumsortorder`);
    expect((r as unknown as { rows: { v: string }[] }).rows.map((x) => x.v)).toEqual(["DRAFT", "OPEN", "CLOSED"]);
  });
});
