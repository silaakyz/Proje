/**
 * Catalog-level guards for the whole migrated schema (0000–0009), so a future table, grant or policy
 * cannot silently widen what browser roles may do. Replaces the removed Prisma migrations.int checks
 * ("every table has RLS", "security-definer functions pin search_path", "RLS helpers answer only for
 * the caller").
 *
 * Effective client write = table privilege AND a permissive policy for that command and role.
 * Several older tables keep Supabase's default table privileges and are closed by RLS alone (no write
 * policy); this test pins that the combination stays closed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ORG_A, ORG_B, setupDb, U } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupDb>>;
beforeAll(async () => {
  ctx = await setupDb();
}, 60_000);

/** Intended browser-writable surface (authenticated only). Everything else is server-only. */
/**
 * Since 0006: attendees are not browser-writable; events and modules_registry INSERT/UPDATE are further
 * limited to owner/admin by their policies (see access-hardening.test.ts), events UPDATE to five columns.
 */
type Cmd = "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" | "REFERENCES" | "TRIGGER" | "MAINTAIN";
/** Privileges RLS does not govern: holding the privilege is the effective permission. */
const NOT_RLS: readonly Cmd[] = ["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
const INTENDED: Partial<Record<Cmd, Record<string, string[] | "all">>> = {
  INSERT: { events: "all", modules_registry: "all" },
  UPDATE: { events: ["end_date", "start_date", "status", "title", "updated_at"], modules_registry: ["configuration", "updated_at"], tasks: ["status", "updated_at"] },
  DELETE: {},
  /** TRUNCATE/TRIGGER ignore RLS, REFERENCES probes keys, MAINTAIN allows REINDEX/LOCK: none for browser roles (0006). */
  TRUNCATE: {},
  REFERENCES: {},
  TRIGGER: {},
  MAINTAIN: {},
};

describe("effective browser write surface", () => {
  it("matches the intended surface exactly for anon and authenticated", async () => {
    const tables = (await ctx.pg.query<{ t: string }>(
      "select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1")).rows.map((r) => r.t);
    expect(tables).toEqual(["ai_generations", "attendees", "budget_items", "data_observations", "event_analytics_vectors", "event_data_sources", "event_datasets",
      "event_impact_inputs", "event_kpis", "event_leads", "event_registration_forms", "event_registrations", "event_sponsors", "event_survey_links", "events",
      "impact_calculation_runs", "media_mentions", "modules_registry", "multiplier_sets", "multipliers", "organization_invitations", "organizations", "proposals",
      "survey_questions", "survey_response_spend", "survey_responses", "surveys", "tasks", "users"]);

    // MAINTAIN exists from PostgreSQL 17 on (PGlite is 17); never assume it on older servers.
    const pg17 = (await ctx.pg.query<{ n: number }>("select current_setting('server_version_num')::int n")).rows[0]!.n >= 170000;
    const cmds: Cmd[] = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", ...(pg17 ? ["MAINTAIN" as const] : [])];
    if (!pg17) delete INTENDED.MAINTAIN;
    const actual: Record<string, Partial<Record<Cmd, Record<string, string[] | "all">>>> = {};
    for (const role of ["anon", "authenticated"]) {
      actual[role] = Object.fromEntries(cmds.map((c) => [c, {}]));
      for (const t of tables) {
        for (const cmd of cmds) {
          const { rows: [r] } = await ctx.pg.query<{ priv: boolean; cols: string | null; pol: number }>(`
            select has_table_privilege($1, 'public.' || $2, $3) as priv,
              case when $3 not in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') then null else
                (select string_agg(a.attname, ',' order by a.attname) from pg_attribute a
                   where a.attrelid = ('public.' || $2)::regclass and a.attnum > 0 and not a.attisdropped
                     and has_column_privilege($1, ('public.' || $2)::regclass, a.attname, $3)) end as cols,
              (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = $2
                 and p.permissive = 'PERMISSIVE' and p.cmd in ($3, 'ALL') and ($1 = any(p.roles) or 'public' = any(p.roles))) as pol`,
            [role, t, cmd]);
          const rlsOn = (await ctx.pg.query<{ on: boolean }>("select relrowsecurity as on from pg_class where oid = ('public.' || $1)::regclass", [t])).rows[0]!.on;
          const policyAllows = NOT_RLS.includes(cmd) || !rlsOn || r!.pol > 0;
          if (!policyAllows) continue;
          if (r!.priv) actual[role]![cmd]![t] = "all";
          else if (r!.cols) actual[role]![cmd]![t] = r!.cols.split(",");
        }
      }
    }
    expect(actual.anon).toEqual(Object.fromEntries(cmds.map((c) => [c, {}])));
    expect(actual.authenticated).toEqual(INTENDED);
  });

  it("every public table has RLS enabled and at least a SELECT policy scoped to the tenant", async () => {
    const r = await ctx.pg.query<{ t: string }>(`
      select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (not c.relrowsecurity or not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.cmd = 'SELECT'))`);
    expect(r.rows).toEqual([]);
  });
});

describe("TRUNCATE (behaviour, not just the catalog)", () => {
  /** Runs `sql` as `role` and always rolls back, so even a successful TRUNCATE leaves no trace. */
  const tryAs = (role: string | null, sqlText: string) =>
    ctx.pg.transaction(async (tx) => {
      if (role) await tx.exec(`set local role ${role}`);
      const res = await tx.query(sqlText).then(() => "ok", (e: Error) => e.message);
      await tx.rollback();
      return res;
    }).catch((e: Error) => (e.message === "Transaction rolled back" ? "ok" : e.message));

  it("anon and authenticated cannot truncate any public table; the table owner can (control)", async () => {
    const tables = (await ctx.pg.query<{ t: string }>(
      "select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1")).rows.map((r) => r.t);
    expect(tables).toHaveLength(29);
    const before = (await ctx.pg.query<{ n: number }>("select count(*)::int as n from organizations")).rows[0]!.n;
    for (const t of tables) {
      for (const role of ["anon", "authenticated"]) {
        const r = await tryAs(role, `truncate table public."${t}"`);
        expect([t, role, r]).toEqual([t, role, expect.stringMatching(/permission denied/)]);
      }
      // control: the owner (server) may, so a missing privilege is what stops the browser roles
      const owner = await tryAs(null, `truncate table public."${t}" cascade`);
      expect([t, owner]).toEqual([t, expect.stringMatching(/^(ok|Transaction rolled back)$/)]);
    }
    expect((await ctx.pg.query<{ n: number }>("select count(*)::int as n from organizations")).rows[0]!.n).toBe(before);
  });

  it("a signed-in owner going through withRls cannot truncate either", async () => {
    expect(await ctx.as(U.ownerA, (tx) => tx.execute("truncate table organizations" as never)).then(() => "ok", (e: { cause?: { message?: string } }) => e.cause?.message))
      .toMatch(/permission denied/);
  });
});

describe("REFERENCES, TRIGGER, MAINTAIN (behaviour)", () => {
  /**
   * Browser roles have no CREATE on any schema, so they could not use REFERENCES/TRIGGER today anyway.
   * To test the table privileges themselves, a rolled-back transaction first gives them a scratch schema
   * they may create in; only the privilege on the public table can then stop them.
   */
  const attempt = (role: string | null, statements: string) =>
    ctx.pg.transaction(async (tx) => {
      await tx.exec(`create schema probe; grant usage, create on schema probe to anon, authenticated;`);
      if (role) await tx.exec(`set local role ${role}`);
      const res = await tx.exec(statements).then(() => "ok", (e: Error) => e.message);
      await tx.rollback();
      return res;
    }).catch((e: Error) => (e.message === "Transaction rolled back" ? "ok" : e.message));
  const tablesP = async () => (await ctx.pg.query<{ t: string }>(
    "select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1")).rows.map((r) => r.t);

  it("no browser role can point a foreign key at a public table (REFERENCES); the owner can (control)", async () => {
    for (const t of await tablesP()) {
      // The probe references the table's primary key (single or composite) with matching column types.
      const pk = (await ctx.pg.query<{ col: string; type: string }>(`
        select a.attname as col, format_type(a.atttypid, a.atttypmod) as type
        from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = ('public.' || $1)::regclass and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`, [t])).rows;
      const cols = pk.map((c) => `"${c.col}"`).join(", ");
      const stmt = `create table probe.fk_probe (${pk.map((c) => `"${c.col}" ${c.type}`).join(", ")}, foreign key (${cols}) references public."${t}"(${cols}));`;
      for (const role of ["anon", "authenticated"]) expect([t, role, await attempt(role, stmt)]).toEqual([t, role, expect.stringMatching(/permission denied for table/)]);
      expect([t, await attempt(null, stmt)]).toEqual([t, "ok"]);
    }
  });

  it("no browser role can attach a trigger to a public table (TRIGGER); the owner can (control)", async () => {
    for (const t of await tablesP()) {
      const stmt = `create function probe.noop() returns trigger language plpgsql as $f$ begin return new; end $f$;
        create trigger probe_trg before insert on public."${t}" for each row execute function probe.noop();`;
      for (const role of ["anon", "authenticated"]) expect([t, role, await attempt(role, stmt)]).toEqual([t, role, expect.stringMatching(/permission denied for table/)]);
      expect([t, await attempt(null, stmt)]).toEqual([t, "ok"]);
    }
  });

  it("no browser role can REINDEX a public table (MAINTAIN, PostgreSQL 17+); the owner can (control)", async () => {
    const pg17 = (await ctx.pg.query<{ n: number }>("select current_setting('server_version_num')::int n")).rows[0]!.n >= 170000;
    expect(pg17).toBe(true); // PGlite is PostgreSQL 17; on older servers this privilege does not exist
    for (const t of await tablesP()) {
      for (const role of ["anon", "authenticated"]) expect([t, role, await attempt(role, `reindex table public."${t}";`)]).toEqual([t, role, expect.stringMatching(/permission denied|must be owner/)]);
      expect([t, await attempt(null, `reindex table public."${t}";`)]).toEqual([t, "ok"]);
    }
  });
});

describe("future tables (default privileges)", () => {
  const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];

  it("a new public table gives anon, authenticated and PUBLIC nothing (explicit-grant model); service_role keeps everything", async () => {
    const res = await ctx.pg.transaction(async (tx) => {
      await tx.exec("create table public.future_probe (id uuid primary key, v int)");
      const rows = (await tx.query<{ role: string; priv: string; has: boolean }>(`
        select r.role, p.priv, has_table_privilege(r.role, 'public.future_probe', p.priv) as has
        from unnest(array['anon', 'authenticated', 'service_role']) r(role), unnest($1::text[]) p(priv) order by 1, 2`, [PRIVS])).rows;
      await tx.rollback();
      return rows;
    }).catch((e: Error) => { throw e; });
    const held = (role: string) => res.filter((r) => r.role === role && r.has).map((r) => r.priv).sort();
    expect(held("anon")).toEqual([]);
    expect(held("authenticated")).toEqual([]);
    expect(held("service_role")).toEqual([...PRIVS].sort());
  });

  it("and on that new table a browser role really cannot TRUNCATE (behaviour)", async () => {
    const r = await ctx.pg.transaction(async (tx) => {
      await tx.exec("create table public.future_probe (id uuid primary key)");
      await tx.exec("set local role authenticated");
      const out = await tx.query("truncate table public.future_probe").then(() => "ok", (e: Error) => e.message);
      await tx.rollback();
      return out;
    }).catch((e: Error) => e.message);
    expect(r).toMatch(/permission denied/);
  });

  it("default privileges keep only service_role for tables and sequences; no PUBLIC entries anywhere", async () => {
    const { rows } = await ctx.pg.query(`select pg_get_userbyid(d.defaclrole) creator, coalesce(n.nspname, '<global>') scope, d.defaclobjtype::text objtype,
      (select array_agg(x::text order by x::text) from unnest(d.defaclacl) x) acl
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1, 2, 3`);
    expect(rows).toEqual([
      { creator: "postgres", scope: "public", objtype: "S", acl: ["service_role=rwU/postgres"] },
      { creator: "postgres", scope: "public", objtype: "r", acl: ["service_role=arwdDxtm/postgres"] },
    ]);
    const report = await ctx.pg.query("select * from app.unsafe_default_acls_0006()");
    expect(report.rows).toEqual([]);
  });

  it("a new sequence (e.g. from serial) gives browser roles nothing; service_role keeps rwU", async () => {
    const rows = await ctx.pg.transaction(async (tx) => {
      await tx.exec("create table public.future_serial (id serial primary key)");
      const r = (await tx.query<{ role: string; priv: string; has: boolean }>(`
        select r.role, p.priv, has_sequence_privilege(r.role, 'public.future_serial_id_seq', p.priv) as has
        from unnest(array['anon', 'authenticated', 'service_role']) r(role), unnest(array['USAGE', 'SELECT', 'UPDATE']) p(priv) order by 1, 2`)).rows;
      await tx.rollback();
      return r;
    });
    expect(rows.filter((r) => r.has).map((r) => `${r.role}:${r.priv}`)).toEqual(["service_role:SELECT", "service_role:UPDATE", "service_role:USAGE"]);
  });

  it("explicit grants open exactly what a migration grants: table SELECT/INSERT plus the serial's sequence USAGE, under RLS", async () => {
    const out = await ctx.pg.transaction(async (tx) => {
      const step = async (sqlText: string) => {
        await tx.exec("savepoint s");
        const r = await tx.exec(sqlText).then(() => "ok", (e: Error) => e.message);
        await tx.exec(r === "ok" ? "release savepoint s" : "rollback to savepoint s");
        return r;
      };
      await tx.exec(`create table public.future_notes (id serial primary key, organization_id uuid not null, body text not null);
        alter table public.future_notes enable row level security;
        create policy future_notes_rw on public.future_notes for all to authenticated
          using (organization_id = (select app.current_organization_id())) with check (organization_id = (select app.current_organization_id()));
        select set_config('request.jwt.claims', '{"sub":"${U.ownerA}","role":"authenticated"}', true), set_config('request.jwt.claim.sub', '${U.ownerA}', true);`);
      const r: Record<string, string> = {};
      r.beforeGrant = await step(`set local role authenticated; select * from public.future_notes; reset role;`);
      await tx.exec("reset role; grant select, insert on public.future_notes to authenticated;");
      r.insertWithoutSequence = await step(`set local role authenticated; insert into public.future_notes (organization_id, body) values ('${ORG_A}', 'x'); reset role;`);
      await tx.exec("reset role; grant usage on sequence public.future_notes_id_seq to authenticated;");
      r.insert = await step(`set local role authenticated; insert into public.future_notes (organization_id, body) values ('${ORG_A}', 'x'); reset role;`);
      r.otherTenant = await step(`set local role authenticated; insert into public.future_notes (organization_id, body) values ('${ORG_B}', 'x'); reset role;`);
      r.update = await step(`set local role authenticated; update public.future_notes set body = 'y'; reset role;`);
      r.anon = await step(`set local role anon; select * from public.future_notes; reset role;`);
      await tx.exec("reset role");
      await tx.rollback();
      return r;
    }).catch((e: Error) => { throw e; });
    expect(out.beforeGrant).toMatch(/permission denied for table future_notes/);
    expect(out.insertWithoutSequence).toMatch(/permission denied for sequence future_notes_id_seq/);
    expect(out.insert).toBe("ok");
    expect(out.otherTenant).toMatch(/row-level security/);
    expect(out.update).toMatch(/permission denied for table future_notes/); // UPDATE was never granted
    expect(out.anon).toMatch(/permission denied for table future_notes/);
  });
});

describe("effective privileges: PUBLIC and role membership count", () => {
  /** In a rolled-back transaction: apply `setup` as the owner, then evaluate `query` (as the owner). */
  const probe = <T,>(setup: string, query: string) =>
    ctx.pg.transaction(async (tx) => {
      await tx.exec(setup);
      const rows = (await tx.query<T>(query)).rows;
      await tx.rollback();
      return rows;
    });

  it("a grant to PUBLIC or to a role that anon/authenticated belong to is seen by has_table_privilege, not by a scan of their own ACL entries", async () => {
    const rows = await probe<{ via_public: boolean; via_member: boolean; own_entry: number }>(
      `grant truncate on organizations to public;
       create role probe_member nologin; grant trigger on users to probe_member; grant probe_member to authenticated;`,
      `select has_table_privilege('anon', 'organizations', 'TRUNCATE') via_public,
              has_table_privilege('authenticated', 'users', 'TRIGGER') via_member,
              (select count(*)::int from pg_class c cross join lateral aclexplode(c.relacl) e
                 where c.relname in ('organizations', 'users') and pg_get_userbyid(e.grantee) in ('anon', 'authenticated')
                   and e.privilege_type in ('TRUNCATE', 'TRIGGER')) own_entry`);
    // the surface matrix and the 0006 fail-closed check use has_table_privilege, so they catch both
    expect(rows).toEqual([{ via_public: true, via_member: true, own_entry: 0 }]);
  });

  it("today nothing reaches anon/authenticated through PUBLIC or membership on public tables", async () => {
    const { rows } = await ctx.pg.query(`select c.relname, e.privilege_type from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) e where n.nspname = 'public' and c.relkind = 'r' and e.grantee = 0`);
    expect(rows).toEqual([]);
    const members = await ctx.pg.query(`select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
      where m.member in (select oid from pg_roles where rolname in ('anon', 'authenticated'))`);
    expect(members.rows).toEqual([]);
  });

  it("on a NEW public table the effective privileges are checked too (PUBLIC default included)", async () => {
    const rows = await probe<{ priv: string; anon: boolean; auth: boolean }>(
      `create table public.future_probe (id uuid primary key);`,
      `select p.priv, has_table_privilege('anon', 'public.future_probe', p.priv) anon, has_table_privilege('authenticated', 'public.future_probe', p.priv) auth
       from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p(priv) order by 1`);
    expect(rows.every((r) => !r.anon && !r.auth)).toBe(true);
    const dml = await probe<{ any: boolean }>(`create table public.future_probe (id uuid primary key);`,
      `select bool_or(has_table_privilege(r, 'public.future_probe', p)) as any from unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p`);
    expect(dml).toEqual([{ any: false }]);
    // and the probe is able to see a PUBLIC default if one existed
    const withPublic = await probe<{ t: boolean }>(
      `alter default privileges in schema public grant truncate on tables to public; create table public.future_probe (id uuid primary key);`,
      `select has_table_privilege('anon', 'public.future_probe', 'TRUNCATE') t`);
    expect(withPublic).toEqual([{ t: true }]);
  });
});

describe("LOCK TABLE (behaviour)", () => {
  const MODES = ["ACCESS SHARE", "ROW SHARE", "ROW EXCLUSIVE", "SHARE UPDATE EXCLUSIVE", "SHARE", "SHARE ROW EXCLUSIVE", "EXCLUSIVE", "ACCESS EXCLUSIVE"];
  const STRONG = MODES.slice(3);
  const lockAs = (role: string, table: string, mode: string, setup = "") =>
    ctx.pg.transaction(async (tx) => {
      if (setup) await tx.exec(setup);
      await tx.exec(`set local role ${role}`);
      const r = await tx.exec(`lock table public."${table}" in ${mode} mode`).then(() => true, () => false);
      await tx.rollback();
      return r;
    }).catch(() => false);

  it("existing tables: no browser role can take any lock stronger than ROW EXCLUSIVE; ROW EXCLUSIVE only where INSERT is intended", async () => {
    const tables = (await ctx.pg.query<{ t: string }>(
      "select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1")).rows.map((r) => r.t);
    const allowed: Record<string, string[]> = {};
    for (const role of ["anon", "authenticated"])
      for (const t of tables)
        for (const mode of MODES) if (await lockAs(role, t, mode)) (allowed[`${role} ${mode}`] ??= []).push(t);
    for (const role of ["anon", "authenticated"]) for (const mode of STRONG) expect([role, mode, allowed[`${role} ${mode}`] ?? []]).toEqual([role, mode, []]);
    expect(allowed["anon ROW EXCLUSIVE"] ?? []).toEqual([]);
    expect(allowed["authenticated ROW EXCLUSIVE"]).toEqual(["events", "modules_registry"]);
    expect(allowed["authenticated ROW SHARE"]).toEqual(["events", "modules_registry"]);
    // ACCESS SHARE follows table-level SELECT (attendees has column-level SELECT only)
    const selectable = async (role: string) => (await ctx.pg.query<{ t: string }>(`select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege($1, c.oid, 'SELECT') order by 1`, [role])).rows.map((r) => r.t);
    expect(allowed["anon ACCESS SHARE"]).toEqual(await selectable("anon"));
    expect(allowed["authenticated ACCESS SHARE"]).toEqual(await selectable("authenticated"));
    expect(allowed["authenticated ACCESS SHARE"]).not.toContain("attendees");
  });

  it("a NEW public table cannot be locked at all by browser roles until a migration grants something", async () => {
    const setup = "create table public.future_probe (id uuid primary key);";
    for (const role of ["anon", "authenticated"])
      for (const mode of MODES) expect([role, mode, await lockAs(role, "future_probe", mode, setup)]).toEqual([role, mode, false]);
    // an explicit SELECT grant allows exactly ACCESS SHARE; a strong lock still needs UPDATE/DELETE/TRUNCATE/MAINTAIN
    const withSelect = setup + " grant select on public.future_probe to authenticated;";
    expect(await lockAs("authenticated", "future_probe", "ACCESS SHARE", withSelect)).toBe(true);
    expect(await lockAs("authenticated", "future_probe", "ROW EXCLUSIVE", withSelect)).toBe(false);
    expect(await lockAs("authenticated", "future_probe", "ACCESS EXCLUSIVE", withSelect)).toBe(false);
  });
});

describe("tenant helper function", () => {
  it("is SECURITY DEFINER with a pinned, empty search_path, and anon cannot execute it", async () => {
    const { rows } = await ctx.pg.query<{ secdef: boolean; config: string[] | null; anon: boolean; auth: boolean }>(`
      select p.prosecdef as secdef, p.proconfig as config,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'current_organization_id'`);
    expect(rows).toEqual([{ secdef: true, config: ['search_path=""'], anon: false, auth: true }]);
    // No other SECURITY DEFINER function exists in our schemas without a pinned search_path.
    const loose = await ctx.pg.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app') and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(loose.rows).toEqual([]);
  });

  it("answers only for the caller", async () => {
    const orgOf = async (u: string) => {
      const r = await ctx.as(u, async (tx) => (await tx.execute("select app.current_organization_id() as o" as never)) as unknown as { rows: { o: string | null }[] });
      return r.rows[0]!.o;
    };
    expect(await orgOf(U.ownerA)).toBe(ORG_A);
    expect(await orgOf(U.staffA)).toBe(ORG_A);
    expect(await orgOf(U.ownerB)).toBe(ORG_B);
    expect(await orgOf(U.noProfile)).toBeNull();
  });
});
