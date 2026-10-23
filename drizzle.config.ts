import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Only our schema: auth, app_private and extensions are created by scripts/db/bootstrap.sql.
  schemaFilter: ["public"],
  // anon / authenticated / service_role are created by scripts/db/bootstrap.sql — don't diff them.
  entities: { roles: { exclude: ["anon", "authenticated", "service_role"] } },
  // `||`, not `??`: .env.example ships `DIRECT_URL=` (empty), which must fall back to DATABASE_URL.
  dbCredentials: { url: process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim() || "" },
  strict: true,
  verbose: true,
});
