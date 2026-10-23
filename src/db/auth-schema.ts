/**
 * Server-only tables outside `public`, created by scripts/db/bootstrap.sql (not by Drizzle migrations:
 * drizzle-kit manages only `public`, see drizzle.config.ts). Declared here so server code can query them
 * with Drizzle. Only the server reads them, through adminDb; the browser roles have no privileges on them.
 * Keep in sync with bootstrap.sql.
 */
import { integer, pgRole, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Role the RLS policies target; withRls switches into it. Created by bootstrap.sql, never by drizzle-kit. */
export const authenticatedRole = pgRole("authenticated").existing();

const auth = pgSchema("auth");

export const authUsers = auth.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
});

export const authSessions = auth.table("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  userAgent: text("user_agent"),
});

export const authPasswordResets = auth.table("password_resets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

const appPrivate = pgSchema("app_private");

export const rateLimits = appPrivate.table(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
