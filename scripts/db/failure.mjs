/**
 * What scripts/db/migrate.mjs prints when a migration run fails (before redaction).
 *
 * drizzle-orm runs all pending migrations in one transaction. Only an error the database raised for a
 * statement (severity ERROR) proves that the transaction was rolled back. Any other failure — connection
 * lost or terminated (also during COMMIT), timeouts, FATAL/PANIC, client-side errors — leaves the outcome
 * unknown, so the operator is told to check the migrations table (read-only) before re-running.
 */
export function describeFailure(e, { migrationsSchema = "drizzle", migrationsTable = "__drizzle_migrations" } = {}) {
  // drizzle-orm wraps the driver error: DrizzleQueryError("Failed query: <sql>") with the pg error as cause.
  // When the connection dies mid-transaction, drizzle-orm's ROLLBACK fails too and is what gets thrown;
  // its cause is still the driver's connection error, which is what the operator needs to see.
  const err = e?.cause && typeof e.cause === "object" ? e.cause : e;
  const severity = typeof err?.severity === "string" ? err.severity : undefined;
  const rejectedStatement = severity === "ERROR";
  const lines = rejectedStatement
    ? ["migrate: FAILED — the database rejected a statement; pending migrations run in one transaction, so none of them was applied or recorded."]
    : [
        "migrate: FAILED — OUTCOME UNKNOWN: the error is not a statement rejected by the database (connection lost or",
        "  terminated, possibly during COMMIT; timeout; FATAL; or a client-side error), so the migration transaction may",
        "  or may not have been committed. Before re-running, check read-only which migrations are recorded:",
        `    select id, hash, created_at from "${migrationsSchema}"."${migrationsTable}" order by id;`,
      ];
  if (err?.code) lines.push(`  ${severity ? "sqlstate" : "code    "}: ${err.code}`);
  if (severity) lines.push(`  severity: ${severity}`);
  lines.push(`  error:    ${err?.message ?? err}`);
  for (const key of ["detail", "hint", "where"]) if (err?.[key]) lines.push(`  ${key.padEnd(8)}: ${err[key]}`);
  if (typeof e?.query === "string") {
    const q = e.query.replace(/\s+/g, " ").trim();
    lines.push(`  statement: ${q.length > 160 ? `${q.slice(0, 160)}…` : q}`);
  }
  return lines;
}
