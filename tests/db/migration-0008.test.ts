
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { ORG_A, U, migrationsUpTo } from "./helpers";

const EVENT_ID = "e8000000-0000-4000-8000-00000000000a";
const ATTENDEE_ID = "f8000000-0000-4000-8000-00000000000a";
const TASK_AUTO_ID = "d8000000-0000-4000-8000-000000000001";
const TASK_MANUAL_ID = "d8000000-0000-4000-8000-000000000002";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });

  await pg.exec(
    fs.readFileSync("scripts/db/bootstrap.sql", "utf8"),
  );

  await pg.exec(
    'set search_path to "$user", public, extensions;',
  );

  // Bring the test database to migration 0007 first.
  await migrate(drizzle({ client: pg }), {
    migrationsFolder: migrationsUpTo(7),
  });

  // Create representative data before applying 0008.
  await pg.exec(`
    insert into auth.users (id, email)
    values ('${U.ownerA}', 'ownerA@example.com');

    insert into organizations (id, name)
    values ('${ORG_A}', 'Migration test organization');

    insert into users (id, organization_id, email, role)
    values (
      '${U.ownerA}',
      '${ORG_A}',
      'ownerA@example.com',
      'owner'
    );

    insert into events (
      id, organization_id, title, status, start_date
    )
    values (
      '${EVENT_ID}',
      '${ORG_A}',
      'Migration test event',
      'draft',
      '2026-11-01'
    );

    insert into attendees (
      id, organization_id, event_id, ticket_type, is_checked_in
    )
    values (
      '${ATTENDEE_ID}',
      '${ORG_A}',
      '${EVENT_ID}',
      'general',
      false
    );

    insert into tasks (
      id, organization_id, event_id, title, status, completed_at
    )
    values
      (
        '${TASK_AUTO_ID}',
        '${ORG_A}',
        '${EVENT_ID}',
        'Automatic completion test',
        'TODO',
        null
      ),
      (
        '${TASK_MANUAL_ID}',
        '${ORG_A}',
        '${EVENT_ID}',
        'Manual completion time test',
        'TODO',
        null
      );
  `);

  // Apply migration 0008 in this isolated PGlite database.
  await migrate(drizzle({ client: pg }), {
    migrationsFolder: migrationsUpTo(8),
  });
}, 120_000);

describe("migration 0008: ticket cancellation and task completion", () => {
  it("adds cancelled_at and preserves existing attendees", async () => {
    const result = await pg.query<{
      cancelled_at: string | null;
      is_checked_in: boolean;
    }>(
      `select cancelled_at, is_checked_in
       from attendees
       where id = $1`,
      [ATTENDEE_ID],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      cancelled_at: null,
      is_checked_in: false,
    });
  });

  it("does not allow a cancelled ticket to be checked in", async () => {
    await pg.query(
      "update attendees set cancelled_at = now() where id = $1",
      [ATTENDEE_ID],
    );

    await expect(
      pg.query(
        "update attendees set is_checked_in = true where id = $1",
        [ATTENDEE_ID],
      ),
    ).rejects.toThrow(/attendees_cancelled_not_checked_in/);
  });

  it("sets completed_at when a task becomes DONE and clears it when reopened", async () => {
    await pg.query(
      "update tasks set status = 'DONE' where id = $1",
      [TASK_AUTO_ID],
    );

    let result = await pg.query<{ completed_at: string | Date | null }>(
      "select completed_at from tasks where id = $1",
      [TASK_AUTO_ID],
    );

    expect(result.rows[0]?.completed_at).not.toBeNull();

    await pg.query(
      "update tasks set status = 'TODO' where id = $1",
      [TASK_AUTO_ID],
    );

    result = await pg.query(
      "select completed_at from tasks where id = $1",
      [TASK_AUTO_ID],
    );

    expect(result.rows[0]?.completed_at).toBeNull();
  });

  it("preserves a completion timestamp explicitly supplied by the writer", async () => {
    const timestamp = "2026-10-01T12:00:00.000Z";

    await pg.query(
      `update tasks
       set status = 'DONE', completed_at = $1::timestamptz
       where id = $2`,
      [timestamp, TASK_MANUAL_ID],
    );

    const result = await pg.query<{ completed_at: string | Date | null }>(
      "select completed_at from tasks where id = $1",
      [TASK_MANUAL_ID],
    );

    expect(
      new Date(result.rows[0]!.completed_at!).toISOString(),
    ).toBe(timestamp);
  });
});
