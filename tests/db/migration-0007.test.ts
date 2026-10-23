/**
 * Migration 0007 (survey responses, impact inputs, multiplier sets, impact runs) as an UPGRADE: a PGlite
 * database is migrated with 0000–0006, filled with representative pre-0007 data, and then only 0007 is
 * applied by drizzle-orm's migrator. Checks: existing rows survive unchanged; the new tables, enums, foreign
 * keys (incl. column-scoped ON DELETE SET NULL), RLS policies and privileges are exactly as intended;
 * cross-organization references are rejected even for the table owner; deleting people and multiplier sets
 * clears only the reference; impact runs cannot be changed.
 * PGlite is PostgreSQL 17 prepared by scripts/db/bootstrap.sql — not a PostgreSQL 15 run.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { ORG_A, ORG_B, U, migrationsUpTo } from "./helpers";

const ADMIN_A = "a0000000-0000-4000-8000-000000000003";
const EV_A = "e7000000-0000-4000-8000-00000000000a";
const EV_A2 = "e7000000-0000-4000-8000-0000000000a2";
const EV_B = "e7000000-0000-4000-8000-00000000000b";
const SV_A = "57000000-0000-4000-8000-00000000000a"; // OPEN before 0007
const SV_A_DRAFT = "57000000-0000-4000-8000-0000000000a2";
const SV_B = "57000000-0000-4000-8000-00000000000b";
const NEW_TABLES = ["event_impact_inputs", "impact_calculation_runs", "multiplier_sets", "multipliers", "survey_response_spend", "survey_responses"];
const MIGRATION = "drizzle/0007_survey_responses_impact.sql";

let pg: PGlite;
/** Pre-0007 tables and their rows (as jsonb, sorted), captured right before 0007 is applied. */
let before: Record<string, unknown[]> = {};

const rowsOf = async (table: string) =>
  (await pg.query<{ r: Record<string, unknown> }>(`select to_jsonb(t) as r from public."${table}" t order by to_jsonb(t)::text`)).rows.map((x) => x.r);
const publicTables = async () =>
  (await pg.query<{ t: string }>("select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1")).rows.map((r) => r.t);

/** Error message of `sqlText` run as the table owner (rolled back to a savepoint), or "ok". */
async function tryOwner(sqlText: string, params: unknown[] = []) {
  await pg.exec("begin");
  try {
    await pg.query(sqlText, params);
    return "ok";
  } catch (e) {
    return (e as Error).message;
  } finally {
    await pg.exec("rollback");
  }
}

/** Runs `sqlText` as a signed-in browser user (role authenticated + JWT claims), always rolled back. */
async function asUser(userId: string | null, sqlText: string) {
  await pg.exec("begin");
  try {
    if (userId) {
      await pg.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
        [JSON.stringify({ sub: userId, role: "authenticated" }), userId]);
      await pg.exec("set local role authenticated");
    } else {
      await pg.exec("set local role anon");
    }
    const r = await pg.query(sqlText);
    return r.rows;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await pg.exec("rollback");
  }
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.exec(fs.readFileSync("scripts/db/bootstrap.sql", "utf8"));
  await pg.exec(`set search_path to "$user", public, extensions;`);
  await migrate(drizzle({ client: pg }), { migrationsFolder: migrationsUpTo(6) });

  // Representative data written while the database is at 0006.
  await pg.exec(`
    insert into auth.users (id, email) values
      ('${U.ownerA}', 'ownerA@example.com'), ('${U.staffA}', 'staffA@example.com'), ('${ADMIN_A}', 'adminA@example.com'), ('${U.ownerB}', 'ownerB@example.com');
    insert into organizations (id, name) values ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
    insert into users (id, organization_id, email, role) values
      ('${U.ownerA}', '${ORG_A}', 'ownerA@example.com', 'owner'), ('${U.staffA}', '${ORG_A}', 'staffA@example.com', 'staff'),
      ('${ADMIN_A}', '${ORG_A}', 'adminA@example.com', 'admin'), ('${U.ownerB}', '${ORG_B}', 'ownerB@example.com', 'owner');
    insert into events (id, organization_id, title, status, start_date, ai_config, ai_config_version) values
      ('${EV_A}', '${ORG_A}', 'İzmir Festivali', 'live', '2026-11-01', '{"event":{"nuts2Code":"TR31","expectedAttendance":5000}}', 'blueprint/v1'),
      ('${EV_A2}', '${ORG_A}', 'Taslak etkinlik', 'draft', null, null, null),
      ('${EV_B}', '${ORG_B}', 'B etkinliği', 'draft', null, null, null);
    insert into attendees (organization_id, event_id, ticket_type, is_checked_in, checked_in_at) values
      ('${ORG_A}', '${EV_A}', 'genel', true, now()), ('${ORG_A}', '${EV_A}', 'genel', false, null), ('${ORG_B}', '${EV_B}', 'vip', false, null);
    insert into tasks (organization_id, event_id, title, assigned_to) values ('${ORG_A}', '${EV_A}', 'Sahne kurulumu', '${U.staffA}');
    insert into event_kpis (organization_id, event_id, metric_name, data_source) values ('${ORG_A}', '${EV_A}', 'nps', 'survey');
    insert into surveys (id, organization_id, event_id, audience, title, status) values
      ('${SV_A}', '${ORG_A}', '${EV_A}', 'ATTENDEE', 'Ziyaretçi anketi', 'OPEN'),
      ('${SV_A_DRAFT}', '${ORG_A}', '${EV_A2}', 'ATTENDEE', 'Taslak anket', 'DRAFT'),
      ('${SV_B}', '${ORG_B}', '${EV_B}', 'ATTENDEE', 'B anketi', 'DRAFT');
    insert into survey_questions (organization_id, event_id, survey_id, audience, question_text, type, question_key, is_mandatory, position) values
      ('${ORG_A}', '${EV_A}', '${SV_A}', 'ATTENDEE', 'Etkinliğin yapıldığı ilde mi yaşıyorsunuz?', 'YES_NO', 'q_is_local', true, 0),
      ('${ORG_B}', '${EV_B}', '${SV_B}', 'ATTENDEE', 'Tavsiye eder misiniz?', 'NPS_0_10', 'q_nps', true, 0);`);

  for (const t of await publicTables()) before[t] = await rowsOf(t);
  expect(Object.keys(before)).toHaveLength(12);
  expect((await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(7);

  // Apply exactly 0007 (later migrations have their own tests).
  await migrate(drizzle({ client: pg }), { migrationsFolder: migrationsUpTo(7) });
}, 120_000);

describe("upgrade 0006 → 0007", () => {
  it("records exactly one new migration: 0007, with the hash of the committed file", async () => {
    const rows = (await pg.query<{ hash: string; created_at: string }>("select hash, created_at::text from drizzle.__drizzle_migrations order by id")).rows;
    expect(rows).toHaveLength(8);
    const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
    const e7 = journal.entries.find((e) => e.idx === 7)!;
    expect(e7.tag).toBe("0007_survey_responses_impact");
    expect(rows[7]).toEqual({ hash: createHash("sha256").update(fs.readFileSync(MIGRATION)).digest("hex"), created_at: String(e7.when) });
  });

  it("keeps every existing row unchanged; surveys only gain public_token = NULL", async () => {
    const after = await publicTables();
    expect(after).toEqual([...Object.keys(before), ...NEW_TABLES].sort());
    for (const [t, rows] of Object.entries(before)) {
      const now = await rowsOf(t);
      if (t === "surveys") {
        expect(now.map((r) => r.public_token)).toEqual([null, null, null]);
        expect(now.map(({ public_token: _, ...r }) => r)).toEqual(rows);
      } else {
        expect([t, now]).toEqual([t, rows]);
      }
    }
    for (const t of NEW_TABLES) expect([t, await rowsOf(t)]).toEqual([t, []]);
  });

  it("creates the new enums with their exact values", async () => {
    const { rows } = await pg.query<{ t: string; v: string[] }>(`
      select t.typname as t, array_agg(e.enumlabel order by e.enumsortorder) as v from pg_type t join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
        and t.typname in ('spend_category', 'survey_response_channel', 'regionalization_method', 'multiplier_type', 'impact_run_status')
      group by t.typname order by 1`);
    expect(rows).toEqual([
      { t: "impact_run_status", v: ["SUCCEEDED", "INSUFFICIENT_DATA"] },
      { t: "multiplier_type", v: ["TYPE_I", "TYPE_II"] },
      { t: "regionalization_method", v: ["NATIONAL", "SLQ", "CILQ", "FLQ", "SURVEY_BASED"] },
      { t: "spend_category", v: ["ACCOMMODATION", "FOOD_BEVERAGE", "LOCAL_TRANSPORT", "INTERCITY_TRANSPORT", "RETAIL_SHOPPING",
        "ENTERTAINMENT_CULTURE", "VENUE_AND_SERVICES", "MARKETING_PRINTING", "OTHER"] },
      { t: "survey_response_channel", v: ["PUBLIC_LINK", "STAFF_ENTRY"] },
    ]);
  });

  it("creates exactly the intended foreign keys: tenant-composite, with column-scoped SET NULL for people and sets", async () => {
    const { rows } = await pg.query<{ name: string; tbl: string; cols: string; ref: string; refcols: string; del: string; setnull: string | null }>(`
      select c.conname as name, c.conrelid::regclass::text as tbl, c.confrelid::regclass::text as ref,
        (select string_agg(a.attname, ',' order by k.ord) from unnest(c.conkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
        (select string_agg(a.attname, ',' order by k.ord) from unnest(c.confkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as refcols,
        c.confdeltype::text as del,
        (select string_agg(a.attname, ',') from unnest(c.confdelsetcols) k(n) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as setnull
      from pg_constraint c where c.contype = 'f' and c.conrelid::regclass::text = any($1) order by 2, 1`, [NEW_TABLES]);
    // del: c = cascade, n = set null, r = restrict
    expect(rows).toEqual([
      { name: "event_impact_inputs_event_same_org_fk", tbl: "event_impact_inputs", cols: "event_id,organization_id", ref: "events", refcols: "id,organization_id", del: "c", setnull: null },
      { name: "event_impact_inputs_multiplier_set_same_org_fk", tbl: "event_impact_inputs", cols: "multiplier_set_id,organization_id", ref: "multiplier_sets", refcols: "id,organization_id", del: "n", setnull: "multiplier_set_id" },
      { name: "event_impact_inputs_organization_id_organizations_id_fk", tbl: "event_impact_inputs", cols: "organization_id", ref: "organizations", refcols: "id", del: "c", setnull: null },
      { name: "event_impact_inputs_updated_by_same_org_fk", tbl: "event_impact_inputs", cols: "updated_by,organization_id", ref: "users", refcols: "id,organization_id", del: "n", setnull: "updated_by" },
      { name: "impact_calculation_runs_event_same_org_fk", tbl: "impact_calculation_runs", cols: "event_id,organization_id", ref: "events", refcols: "id,organization_id", del: "c", setnull: null },
      { name: "impact_calculation_runs_multiplier_set_same_org_fk", tbl: "impact_calculation_runs", cols: "multiplier_set_id,organization_id", ref: "multiplier_sets", refcols: "id,organization_id", del: "r", setnull: null },
      { name: "impact_calculation_runs_organization_id_organizations_id_fk", tbl: "impact_calculation_runs", cols: "organization_id", ref: "organizations", refcols: "id", del: "c", setnull: null },
      { name: "impact_calculation_runs_triggered_by_same_org_fk", tbl: "impact_calculation_runs", cols: "triggered_by,organization_id", ref: "users", refcols: "id,organization_id", del: "n", setnull: "triggered_by" },
      { name: "multiplier_sets_created_by_same_org_fk", tbl: "multiplier_sets", cols: "created_by,organization_id", ref: "users", refcols: "id,organization_id", del: "n", setnull: "created_by" },
      { name: "multiplier_sets_organization_id_organizations_id_fk", tbl: "multiplier_sets", cols: "organization_id", ref: "organizations", refcols: "id", del: "c", setnull: null },
      { name: "multipliers_set_same_org_fk", tbl: "multipliers", cols: "set_id,organization_id", ref: "multiplier_sets", refcols: "id,organization_id", del: "c", setnull: null },
      { name: "survey_response_spend_response_same_org_fk", tbl: "survey_response_spend", cols: "response_id,organization_id", ref: "survey_responses", refcols: "id,organization_id", del: "c", setnull: null },
      { name: "survey_responses_entered_by_same_org_fk", tbl: "survey_responses", cols: "entered_by,organization_id", ref: "users", refcols: "id,organization_id", del: "n", setnull: "entered_by" },
      { name: "survey_responses_excluded_by_same_org_fk", tbl: "survey_responses", cols: "excluded_by,organization_id", ref: "users", refcols: "id,organization_id", del: "n", setnull: "excluded_by" },
      { name: "survey_responses_organization_id_organizations_id_fk", tbl: "survey_responses", cols: "organization_id", ref: "organizations", refcols: "id", del: "c", setnull: null },
      { name: "survey_responses_survey_same_scope_fk", tbl: "survey_responses", cols: "survey_id,organization_id,event_id,audience", ref: "surveys", refcols: "id,organization_id,event_id,audience", del: "c", setnull: null },
    ]);
  });

  it("enables RLS on every new table with exactly one tenant-scoped SELECT policy (responses: owner/admin only)", async () => {
    const rls = (await pg.query<{ t: string; on: boolean; forced: boolean }>(
      "select relname as t, relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = any($1) and relkind = 'r' order by 1", [NEW_TABLES])).rows;
    expect(rls).toEqual(NEW_TABLES.map((t) => ({ t, on: true, forced: false })));
    const pol = (await pg.query<{ t: string; n: string; cmd: string; roles: string; q: string; w: string | null; permissive: string }>(
      "select tablename as t, policyname as n, cmd, roles::text, qual as q, with_check as w, permissive from pg_policies where tablename = any($1) order by 1, 2", [NEW_TABLES])).rows;
    expect(pol.map((p) => [p.t, p.n, p.cmd, p.roles, p.permissive, p.w])).toEqual(NEW_TABLES.map((t) => [t, `${t}_select_own_org`, "SELECT", "{authenticated}", "PERMISSIVE", null]));
    for (const p of pol) {
      expect(p.q).toContain("current_organization_id()");
      if (p.t.startsWith("survey_respon")) expect(p.q).toMatch(/current_user_role\(\).*'owner'.*'admin'/);
      else expect(p.q).not.toContain("current_user_role");
    }
  });

  it("grants browser roles SELECT only (authenticated) and nothing at all to anon; no column-level extras", async () => {
    const privs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
    const { rows } = await pg.query<{ role: string; t: string; p: string }>(`
      select r.role, t.t, p.p from unnest(array['anon', 'authenticated']) r(role), unnest($1::text[]) t(t), unnest($2::text[]) p(p)
      where has_table_privilege(r.role, 'public.' || t.t, p.p) order by 1, 2, 3`, [NEW_TABLES, privs]);
    expect(rows).toEqual(NEW_TABLES.map((t) => ({ role: "authenticated", t, p: "SELECT" })));
    const colWrites = (await pg.query(`
      select r.role, t.t from unnest(array['anon', 'authenticated']) r(role), unnest($1::text[]) t(t)
      where has_any_column_privilege(r.role, 'public.' || t.t, 'INSERT') or has_any_column_privilege(r.role, 'public.' || t.t, 'UPDATE')`, [NEW_TABLES])).rows;
    expect(colWrites).toEqual([]);
    // The new surveys column is not browser-writable either.
    expect((await pg.query(`select has_column_privilege('authenticated', 'public.surveys', 'public_token', 'UPDATE') as u,
      has_column_privilege('authenticated', 'public.surveys', 'public_token', 'INSERT') as i`)).rows).toEqual([{ u: false, i: false }]);
    // The immutability trigger function is not callable by anyone but its owner.
    expect((await pg.query(`select has_function_privilege('authenticated', 'app.impact_calculation_runs_immutable()', 'EXECUTE') as a,
      has_function_privilege('anon', 'app.impact_calculation_runs_immutable()', 'EXECUTE') as b`)).rows).toEqual([{ a: false, b: false }]);
  });

  it("the manual 0006 rollback refuses to run now that 0007 is applied", async () => {
    const err = await pg.exec(fs.readFileSync("drizzle/rollback/0006_access_hardening.down.sql", "utf8")).then(() => "ran", (e: Error) => e.message);
    await pg.exec("rollback").catch(() => undefined);
    expect(err).toMatch(/1 migration\(s\) were applied after 0006; roll them back first/);
    expect((await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(8);
  });
});

describe("behaviour on the upgraded database", () => {
  const SET_A = "5e700000-0000-4000-8000-00000000000a";
  const SET_A_SPARE = "5e700000-0000-4000-8000-0000000000a2";
  const SET_B = "5e700000-0000-4000-8000-00000000000b";
  const RESP_A = "4e500000-0000-4000-8000-00000000000a";
  const RUN_A = "40400000-0000-4000-8000-00000000000a";
  const run = (id: string, org: string, ev: string, setId: string | null, by: string | null) => `
    insert into impact_calculation_runs (id, organization_id, event_id, requested_level, achieved_level, status, engine_version, data_sufficiency,
      input_snapshot, multiplier_set_id, attendance_basis, attendance_used, sample_size, gross_direct_spend, attributable_spend, total_output_impact,
      total_value_added, total_income, total_employment_fte, triggered_by)
    values ('${id}', '${org}', '${ev}', 'economic_impact', 'economic_impact', 'SUCCEEDED', 'impact-engine/1.0.0', '[]', '{}', ${setId ? `'${setId}'` : "null"},
      'CHECKIN', 1000, 200, 350000, 252000, 299700, 108000, 54000, 2.43, ${by ? `'${by}'` : "null"})`;

  beforeAll(async () => {
    await pg.exec(`
      insert into multiplier_sets (id, organization_id, name, source, io_base_year, price_year, nuts2_code, method, multiplier_type, created_by) values
        ('${SET_A}', '${ORG_A}', 'TR31 test', 'Test verisi, gerçek tablo değildir', 2023, 2026, 'TR31', 'FLQ', 'TYPE_I', '${ADMIN_A}'),
        ('${SET_A_SPARE}', '${ORG_A}', 'Yedek', 'Test verisi, gerçek tablo değildir', 2023, 2026, null, 'NATIONAL', 'TYPE_I', '${U.staffA}'),
        ('${SET_B}', '${ORG_B}', 'B seti', 'Test verisi, gerçek tablo değildir', 2023, 2026, null, 'NATIONAL', 'TYPE_I', '${U.ownerB}');
      insert into multipliers (set_id, organization_id, spend_category, output, value_added, income, employment_per_m_try) values
        ('${SET_A}', '${ORG_A}', 'ACCOMMODATION', 1.5, 0.6, 0.3, 10);
      insert into event_impact_inputs (event_id, organization_id, price_year, leakage, leakage_source, multiplier_set_id, updated_by) values
        ('${EV_A}', '${ORG_A}', 2026, 0.25, 'Test: kayıtlı leakage kaynağı', '${SET_A_SPARE}', '${ADMIN_A}');
      insert into survey_responses (id, organization_id, event_id, survey_id, audience, survey_version, channel, entered_by, answers,
        is_local_resident, party_size, days_present, is_excluded, exclusion_reason, excluded_by, excluded_at) values
        ('${RESP_A}', '${ORG_A}', '${EV_A}', '${SV_A}', 'ATTENDEE', 1, 'STAFF_ENTRY', '${U.staffA}', '{"q_is_local": false}',
         false, 2, 2, true, 'Test girişi', '${ADMIN_A}', now());
      insert into survey_response_spend (response_id, organization_id, category, amount_kurus) values ('${RESP_A}', '${ORG_A}', 'ACCOMMODATION', 100000);
      ${run(RUN_A, ORG_A, EV_A, SET_A, ADMIN_A)};`);
  });

  it("rejects every cross-organization reference, even for the table owner (composite foreign keys)", async () => {
    const fk = (name: string) => new RegExp(`violates foreign key constraint "${name}"`);
    // a response claiming org B for org A's survey / event
    expect(await tryOwner(`insert into survey_responses (organization_id, event_id, survey_id, audience, survey_version, channel, answers)
      values ('${ORG_B}', '${EV_A}', '${SV_A}', 'ATTENDEE', 1, 'PUBLIC_LINK', '{}')`)).toMatch(fk("survey_responses_survey_same_scope_fk"));
    // a response for org A's survey but another event / audience of the same org
    expect(await tryOwner(`insert into survey_responses (organization_id, event_id, survey_id, audience, survey_version, channel, answers)
      values ('${ORG_A}', '${EV_A2}', '${SV_A}', 'ATTENDEE', 1, 'PUBLIC_LINK', '{}')`)).toMatch(fk("survey_responses_survey_same_scope_fk"));
    expect(await tryOwner(`insert into survey_responses (organization_id, event_id, survey_id, audience, survey_version, channel, answers)
      values ('${ORG_A}', '${EV_A}', '${SV_A}', 'RESIDENT', 1, 'PUBLIC_LINK', '{}')`)).toMatch(fk("survey_responses_survey_same_scope_fk"));
    // staff of another organization typing in a response
    expect(await tryOwner(`insert into survey_responses (organization_id, event_id, survey_id, audience, survey_version, channel, entered_by, answers)
      values ('${ORG_A}', '${EV_A}', '${SV_A}', 'ATTENDEE', 1, 'STAFF_ENTRY', '${U.ownerB}', '{}')`)).toMatch(fk("survey_responses_entered_by_same_org_fk"));
    expect(await tryOwner(`update survey_responses set excluded_by = '${U.ownerB}' where id = '${RESP_A}'`)).toMatch(fk("survey_responses_excluded_by_same_org_fk"));
    // a spend line filed under another organization
    expect(await tryOwner(`insert into survey_response_spend (response_id, organization_id, category, amount_kurus)
      values ('${RESP_A}', '${ORG_B}', 'FOOD_BEVERAGE', 1)`)).toMatch(fk("survey_response_spend_response_same_org_fk"));
    // coefficients for another organization's set; a set created by someone from another organization
    expect(await tryOwner(`insert into multipliers (set_id, organization_id, spend_category, output, value_added, income, employment_per_m_try)
      values ('${SET_B}', '${ORG_A}', 'OTHER', 1, 1, 1, 1)`)).toMatch(fk("multipliers_set_same_org_fk"));
    expect(await tryOwner(`update multiplier_sets set created_by = '${U.ownerB}' where id = '${SET_A}'`)).toMatch(fk("multiplier_sets_created_by_same_org_fk"));
    // impact inputs on another organization's event, pointing at another organization's set, or edited by an outsider
    expect(await tryOwner(`insert into event_impact_inputs (event_id, organization_id, price_year) values ('${EV_B}', '${ORG_A}', 2026)`))
      .toMatch(fk("event_impact_inputs_event_same_org_fk"));
    expect(await tryOwner(`update event_impact_inputs set multiplier_set_id = '${SET_B}' where event_id = '${EV_A}'`)).toMatch(fk("event_impact_inputs_multiplier_set_same_org_fk"));
    expect(await tryOwner(`update event_impact_inputs set updated_by = '${U.ownerB}' where event_id = '${EV_A}'`)).toMatch(fk("event_impact_inputs_updated_by_same_org_fk"));
    // runs on another organization's event, with another organization's set, triggered by an outsider
    expect(await tryOwner(run("40400000-0000-4000-8000-000000000001", ORG_A, EV_B, SET_A, null))).toMatch(fk("impact_calculation_runs_event_same_org_fk"));
    expect(await tryOwner(run("40400000-0000-4000-8000-000000000002", ORG_A, EV_A, SET_B, null))).toMatch(fk("impact_calculation_runs_multiplier_set_same_org_fk"));
    expect(await tryOwner(run("40400000-0000-4000-8000-000000000003", ORG_A, EV_A, SET_A, U.ownerB))).toMatch(fk("impact_calculation_runs_triggered_by_same_org_fk"));
    // moving an existing response to another organization
    expect(await tryOwner(`update survey_responses set organization_id = '${ORG_B}' where id = '${RESP_A}'`)).toMatch(/violates foreign key constraint/);
  });

  it("RLS on the upgraded data: responses for owner/admin of the tenant only; other tables for every member of the tenant", async () => {
    expect(await asUser(U.ownerA, "select id from survey_responses")).toEqual([{ id: RESP_A }]);
    expect(await asUser(ADMIN_A, "select response_id from survey_response_spend")).toEqual([{ response_id: RESP_A }]);
    expect(await asUser(U.staffA, "select id from survey_responses")).toEqual([]);
    expect(await asUser(U.staffA, "select response_id from survey_response_spend")).toEqual([]);
    expect(await asUser(U.ownerB, "select id from survey_responses")).toEqual([]);
    expect(await asUser(U.staffA, "select id from impact_calculation_runs")).toEqual([{ id: RUN_A }]);
    expect(await asUser(U.staffA, "select id from multiplier_sets order by id")).toEqual([{ id: SET_A }, { id: SET_A_SPARE }]);
    expect(await asUser(U.ownerB, "select id from multiplier_sets")).toEqual([{ id: SET_B }]);
    expect(await asUser(U.ownerB, "select event_id from event_impact_inputs")).toEqual([]);
    expect(await asUser(U.ownerB, "select set_id from multipliers")).toEqual([]);
    expect(await asUser(null, "select id from survey_responses")).toMatch(/permission denied for table survey_responses/);
    // no browser write at all, not even by the owner of the tenant
    expect(await asUser(U.ownerA, `insert into multiplier_sets (organization_id, name, source, io_base_year, price_year, method, multiplier_type)
      values ('${ORG_A}', 'x', 'Test verisi, gerçek değil', 2023, 2026, 'NATIONAL', 'TYPE_I')`)).toMatch(/permission denied for table multiplier_sets/);
    expect(await asUser(U.ownerA, `update event_impact_inputs set leakage = 0`)).toMatch(/permission denied for table event_impact_inputs/);
    expect(await asUser(U.ownerA, `delete from survey_responses`)).toMatch(/permission denied for table survey_responses/);
    expect(await asUser(U.ownerA, `update surveys set public_token = '${"a".repeat(43)}'`)).toMatch(/permission denied for table surveys/);
  });

  it("impact runs are immutable: no UPDATE of any column, not even by the table owner; browsers cannot touch them", async () => {
    for (const set of ["total_output_impact = 1", "achieved_level = 'spend', total_output_impact = null, total_value_added = null, total_income = null, total_employment_fte = null, attributable_spend = null",
      "input_snapshot = '{\"x\":1}'", "created_at = now()", "organization_id = organization_id", "triggered_by = null"]) {
      expect([set, await tryOwner(`update impact_calculation_runs set ${set} where id = '${RUN_A}'`)]).toEqual([set, expect.stringMatching(/immutable/)]);
    }
    expect(await asUser(U.ownerA, `update impact_calculation_runs set total_income = 0`)).toMatch(/permission denied for table impact_calculation_runs/);
    expect(await asUser(U.ownerA, `delete from impact_calculation_runs`)).toMatch(/permission denied for table impact_calculation_runs/);
    expect((await pg.query(`select total_output_impact from impact_calculation_runs where id = '${RUN_A}'`)).rows).toEqual([{ total_output_impact: "299700.00" }]);
    // a multiplier set used by a run cannot be deleted
    expect(await tryOwner(`delete from multiplier_sets where id = '${SET_A}'`)).toMatch(/impact_calculation_runs_multiplier_set_same_org_fk/);
  });

  it("deleting a multiplier set clears only the reference in the event's inputs (organization_id kept)", async () => {
    await pg.query(`delete from multiplier_sets where id = $1`, [SET_A_SPARE]);
    expect((await pg.query(`select organization_id, multiplier_set_id, price_year, leakage_source from event_impact_inputs where event_id = $1`, [EV_A])).rows)
      .toEqual([{ organization_id: ORG_A, multiplier_set_id: null, price_year: 2026, leakage_source: "Test: kayıtlı leakage kaynağı" }]);
  });

  it("deleting a person (KVKK erasure) clears only their references — including on an immutable run — and keeps every row", async () => {
    const counts = async () => (await pg.query<Record<string, number>>(`select
      (select count(*)::int from survey_responses) r, (select count(*)::int from survey_response_spend) s, (select count(*)::int from multiplier_sets) m,
      (select count(*)::int from event_impact_inputs) i, (select count(*)::int from impact_calculation_runs) c`)).rows[0];
    const n0 = await counts();
    // staffA entered the response; adminA excluded it, created the set, updated the inputs and triggered the run.
    await pg.query("delete from auth.users where id = $1", [U.staffA]);
    await pg.query("delete from auth.users where id = $1", [ADMIN_A]);
    expect(await counts()).toEqual(n0);
    expect((await pg.query(`select organization_id, entered_by, excluded_by, is_excluded, exclusion_reason from survey_responses where id = $1`, [RESP_A])).rows)
      .toEqual([{ organization_id: ORG_A, entered_by: null, excluded_by: null, is_excluded: true, exclusion_reason: "Test girişi" }]);
    expect((await pg.query(`select organization_id, created_by from multiplier_sets where id = $1`, [SET_A])).rows).toEqual([{ organization_id: ORG_A, created_by: null }]);
    expect((await pg.query(`select organization_id, updated_by from event_impact_inputs where event_id = $1`, [EV_A])).rows).toEqual([{ organization_id: ORG_A, updated_by: null }]);
    expect((await pg.query(`select organization_id, triggered_by, total_output_impact, multiplier_set_id from impact_calculation_runs where id = $1`, [RUN_A])).rows)
      .toEqual([{ organization_id: ORG_A, triggered_by: null, total_output_impact: "299700.00", multiplier_set_id: SET_A }]);
    // the erasure exception is exactly that: everything else on the run is still frozen
    expect(await tryOwner(`update impact_calculation_runs set total_income = 1 where id = '${RUN_A}'`)).toMatch(/immutable/);
    expect(await tryOwner(`update impact_calculation_runs set triggered_by = '${U.ownerA}' where id = '${RUN_A}'`)).toMatch(/immutable/);
    // and a direct UPDATE that merely clears the person is refused too: only the foreign-key action may do that
    expect(await tryOwner(`update impact_calculation_runs set triggered_by = null where id = '${RUN_A}'`)).toMatch(/immutable/);
    // the pre-existing task assignment behaves as before 0007
    expect((await pg.query(`select assigned_to from tasks`)).rows).toEqual([{ assigned_to: null }]);
  });

  it("deleting an event or an organization still removes its data (cascade is not blocked by the immutability trigger)", async () => {
    await pg.query("delete from events where id = $1", [EV_A]);
    expect((await pg.query(`select
      (select count(*)::int from survey_responses where event_id = '${EV_A}') r, (select count(*)::int from impact_calculation_runs where event_id = '${EV_A}') c,
      (select count(*)::int from event_impact_inputs where event_id = '${EV_A}') i, (select count(*)::int from survey_response_spend where response_id = '${RESP_A}') s`)).rows)
      .toEqual([{ r: 0, c: 0, i: 0, s: 0 }]);
    await pg.query("delete from organizations where id = $1", [ORG_B]);
    expect((await pg.query(`select count(*)::int as n from multiplier_sets where organization_id = '${ORG_B}'`)).rows).toEqual([{ n: 0 }]);
  });
});
