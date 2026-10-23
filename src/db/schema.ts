/**
 * Live Event OS — tenant-isolated schema (Drizzle ORM, PostgreSQL; prerequisites in scripts/db/bootstrap.sql).
 *
 * Isolation model
 *  - Every tenant-owned table carries `organization_id`, including child tables of `events`.
 *  - Child tables reference events through a COMPOSITE foreign key (event_id, organization_id) →
 *    events(id, organization_id), so a row can never claim one tenant while pointing at another
 *    tenant's event.
 *  - RLS policies are declared here (drizzle-kit emits them into migrations). They compare
 *    organization_id with app.current_organization_id(), a SECURITY DEFINER helper created in
 *    migration 0000 (it must read `users` without recursing into users' own policy).
 *  - Browser roles read their own tenant's rows. Since 0006, browser writes are limited to owner/admin
 *    on events (title, status, dates only) and modules_registry (configuration only on UPDATE), and to
 *    the task status column; organizations, users and analytics vectors are never browser-writable;
 *    attendees are readable by owner/admin only, never writable, and qr_uuid is not readable at all.
 *  - Explicit-grant model (0006): new public tables and sequences get NO privileges for anon,
 *    authenticated or PUBLIC by default. The migration that creates a table must GRANT exactly what the
 *    browser needs (and USAGE on its sequence, if any), next to its RLS policies; tests/db/
 *    security-surface.test.ts lists every public table and fails until the new one is accounted for.
 *    No DELETE policy exists anywhere: deletes go through server code.
 *  - Migration 0004 (Blueprint port) adds ai_generations and the columns the AI Blueprint needs on
 *    organizations, events, proposals, tasks, event_kpis and survey_questions. All of them are
 *    server-written; client privileges are unchanged.
 *  - Migration 0005 adds the `surveys` header table (title, intro, target, status, version, fingerprint);
 *    survey_questions belong to one survey version. Server-only writes.
 *  - Migration 0007 adds survey responses (anonymous: no name, contact or attendee link) with their spend
 *    lines, the per-event impact inputs (sourced assumptions + chosen multiplier set), organization-owned
 *    multiplier sets, and immutable impact calculation runs. All server-written; browser roles get SELECT
 *    only (explicit grants in 0007), responses for owner/admin only.
 *  - Migration 0008 adds attendees.cancelled_at (voided tickets; readable like the other non-secret attendee
 *    columns) and a trigger that keeps tasks.completed_at in step with the DONE status for every writer.
 */
import { sql, type SQLWrapper } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  doublePrecision,
  integer,
  varchar,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUsers } from "./auth-schema";
// Relative imports (not "@/…") so drizzle-kit can load this file without the app's path aliases.
import { EVENT_PHASES, ORGANIZER_TYPES, SURVEY_AUDIENCES, TASK_BOARDS, TASK_PRIORITIES } from "../lib/domain/enums";
import { SPEND_CATEGORIES, SURVEY_QUESTION_TYPES } from "../lib/metrics/question-bank";
import { BUDGET_CATEGORIES, MAX_BUDGET_KURUS } from "../lib/budget/categories";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const subscriptionTier = pgEnum("subscription_tier", ["free", "pro", "enterprise"]);
export const userRole = pgEnum("user_role", ["owner", "admin", "staff"]);
export const eventStatus = pgEnum("event_status", ["draft", "live", "completed"]);
export const moduleType = pgEnum("module_type", ["stage", "booth", "session", "survey"]);
/**
 * Which level of the impact model a stored figure reached. A net economic impact may only be stored
 * when the level is `economic_impact` (CHECK below); otherwise the row says why it is absent.
 */
export const impactLevel = pgEnum("impact_level", ["insufficient_data", "spend", "attributable_spend", "economic_impact"]);
/** Who organizes (0004). Drives module recommendations; never restricts event formats. */
export const organizerType = pgEnum("organizer_type", ORGANIZER_TYPES);

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** The caller's organization, resolved from auth.uid() by a SECURITY DEFINER function (migration 0000). */
const currentOrg = sql`(select app.current_organization_id())`;

/** The caller's role in their organization (0006), resolved like currentOrg by a SECURITY DEFINER function. */
const currentRole = sql`(select app.current_user_role())`;

/**
 * Roles RLS lets write or read a table directly from the browser (0006). Kept equal to the matching
 * ORG_PERMISSIONS entries in src/server/auth/org-access.ts (parity-tested against pg_policies).
 */
export const RLS_ROLES = {
  /** events, modules_registry: INSERT / UPDATE (ORG_PERMISSIONS["event.write"]). */
  eventWrite: ["owner", "admin"],
  /** attendees: SELECT (ORG_PERMISSIONS["attendee.read"]). */
  attendeeRead: ["owner", "admin"],
  /** survey_responses, survey_response_spend: SELECT (ORG_PERMISSIONS["survey.manage"], 0007). */
  surveyResponseRead: ["owner", "admin"],
  /** budget_items: SELECT (ORG_PERMISSIONS["budget.read"], 0012). */
  budgetRead: ["owner", "admin"],
} as const satisfies Record<string, readonly ("owner" | "admin" | "staff")[]>;

const roleIn = (roles: readonly string[]) => sql.raw(`(${roles.map((r) => `'${r}'`).join(", ")})`);

/**
 * Every member reads the organization's rows; only `writers` may INSERT / UPDATE them (0006: staff no
 * longer writes). No DELETE policy. Column privileges in the migrations narrow what can be written.
 */
const tenantManagedPolicies = (
  table: string,
  orgCol: AnyPgColumn | SQLWrapper,
  writers: readonly string[],
  /** Extra condition on browser INSERTs (column values the browser may not set). */
  insertCheck?: SQLWrapper,
) => [
  pgPolicy(`${table}_select_own_org`, { for: "select", to: authenticatedRole, using: sql`${orgCol} = ${currentOrg}` }),
  pgPolicy(`${table}_insert_own_org`, {
    for: "insert",
    to: authenticatedRole,
    withCheck: insertCheck
      ? sql`${orgCol} = ${currentOrg} and ${currentRole} in ${roleIn(writers)} and ${insertCheck}`
      : sql`${orgCol} = ${currentOrg} and ${currentRole} in ${roleIn(writers)}`,
  }),
  // USING limits which rows can be targeted; WITH CHECK stops moving a row into another tenant.
  pgPolicy(`${table}_update_own_org`, {
    for: "update",
    to: authenticatedRole,
    using: sql`${orgCol} = ${currentOrg} and ${currentRole} in ${roleIn(writers)}`,
    withCheck: sql`${orgCol} = ${currentOrg} and ${currentRole} in ${roleIn(writers)}`,
  }),
];

// ---------------------------------------------------------------------------
// organizations — read-only for browser roles (subscription_tier is billing state)
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    subscriptionTier: subscriptionTier("subscription_tier").notNull().default("free"),
    organizerType: organizerType("organizer_type").notNull().default("OTHER"),
    ...timestamps,
  },
  (t) => [
    check("organizations_name_not_blank", sql`length(trim(${t.name})) > 0`),
    pgPolicy("organizations_select_own", { for: "select", to: authenticatedRole, using: sql`${t.id} = ${currentOrg}` }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// users — app profile of an account in auth.users (own sign-in, src/server/auth). Read-only for browser roles:
// letting a user UPDATE their own row would let them change `role` or `organization_id`.
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: userRole("role").notNull().default("staff"),
    ...timestamps,
  },
  (t) => [
    // Target of composite FKs: a reference to a user must also name that user's organization.
    unique("users_id_organization_id_uq").on(t.id, t.organizationId),
    index("users_organization_id_idx").on(t.organizationId),
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    pgPolicy("users_select_own_org", { for: "select", to: authenticatedRole, using: sql`${t.organizationId} = ${currentOrg}` }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// organization_invitations (0009) — server-only. An owner/admin invites an address with a role; the invitee
// opens the link (random token, only its sha256 stored), signs in with that address and joins. Owners and
// admins may read their organization's invitations; nothing is browser-writable (no grants at all).
// ---------------------------------------------------------------------------

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: userRole("role").notNull(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    invitedByEmail: text("invited_by_email"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("organization_invitations_token_hash_uq").on(t.tokenHash),
    // one open invitation per address and organization
    uniqueIndex("organization_invitations_open_email_uq")
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check("organization_invitations_role_not_owner", sql`${t.role} in ('admin', 'staff')`),
    check("organization_invitations_email_not_blank", sql`length(trim(${t.email})) > 0`),
    check("organization_invitations_closed_once", sql`${t.acceptedAt} is null or ${t.revokedAt} is null`),
    pgPolicy("organization_invitations_select_own_org", {
      for: "select",
      to: authenticatedRole,
      using: sql`${t.organizationId} = ${currentOrg} and ${currentRole} in ('owner', 'admin')`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: eventStatus("status").notNull().default("draft"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    /**
     * The approved Blueprint core profile (0004), validated by blueprintCoreSchema before it is stored.
     * Later Blueprint stages read the event's format, region, modules and objectives from here.
     */
    aiConfig: jsonb("ai_config").$type<Record<string, unknown>>(),
    /** Contract version of ai_config, e.g. "blueprint/v1". Present exactly when ai_config is. */
    aiConfigVersion: text("ai_config_version"),
    /** 0009: hidden from the default event lists; set and cleared by the server (owner/admin). */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Target of the composite foreign keys below.
    unique("events_id_organization_id_uq").on(t.id, t.organizationId),
    index("events_organization_id_status_idx").on(t.organizationId, t.status),
    check("events_title_not_blank", sql`length(trim(${t.title})) > 0`),
    check("events_dates_ordered", sql`${t.endDate} is null or ${t.startDate} is null or ${t.endDate} >= ${t.startDate}`),
    check("events_live_needs_dates", sql`${t.status} = 'draft' or ${t.startDate} is not null`),
    check("events_ai_config_is_object", sql`${t.aiConfig} is null or jsonb_typeof(${t.aiConfig}) = 'object'`),
    check("events_ai_config_versioned", sql`(${t.aiConfig} is null) = (${t.aiConfigVersion} is null)`),
    // 0006: a browser-created event never carries an AI profile (Drizzle sends DEFAULT for every column,
    // so ai_config needs INSERT privilege; this check keeps it NULL). UPDATE is narrowed by column grants.
    ...tenantManagedPolicies("events", t.organizationId, RLS_ROLES.eventWrite, sql`${t.aiConfig} is null and ${t.aiConfigVersion} is null and ${t.archivedAt} is null`),
  ],
);

// ---------------------------------------------------------------------------
// modules_registry — which modules an event uses and their configuration
// ---------------------------------------------------------------------------

export const modulesRegistry = pgTable(
  "modules_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    eventId: uuid("event_id").notNull(),
    moduleType: moduleType("module_type").notNull(),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "modules_registry_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    unique("modules_registry_event_module_uq").on(t.eventId, t.moduleType),
    index("modules_registry_organization_id_idx").on(t.organizationId),
    check("modules_registry_configuration_is_object", sql`jsonb_typeof(${t.configuration}) = 'object'`),
    ...tenantManagedPolicies("modules_registry", t.organizationId, RLS_ROLES.eventWrite),
  ],
);

// ---------------------------------------------------------------------------
// attendees
// ---------------------------------------------------------------------------

export const attendees = pgTable(
  "attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    eventId: uuid("event_id").notNull(),
    ticketType: text("ticket_type").notNull(),
    /** Random v4 UUID printed in the QR code. Unique platform-wide so a scan resolves to one attendee. */
    qrUuid: uuid("qr_uuid").notNull().defaultRandom(),
    isCheckedIn: boolean("is_checked_in").notNull().default(false),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    /** 0008: a voided ticket (issued by mistake). It can no longer check in and counts nowhere. */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "attendees_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("attendees_qr_uuid_uq").on(t.qrUuid),
    index("attendees_organization_id_idx").on(t.organizationId),
    index("attendees_event_id_idx").on(t.eventId),
    check("attendees_ticket_type_not_blank", sql`length(trim(${t.ticketType})) > 0`),
    check("attendees_checkin_consistent", sql`${t.isCheckedIn} = (${t.checkedInAt} is not null)`),
    check("attendees_cancelled_not_checked_in", sql`${t.cancelledAt} is null or not ${t.isCheckedIn}`),
    // 0006: read by owner/admin only; no browser writes (registration and check-in are server-side).
    // Column privileges (migration 0006) also hide qr_uuid from every browser role.
    pgPolicy("attendees_select_own_org", {
      for: "select",
      to: authenticatedRole,
      using: sql`${t.organizationId} = ${currentOrg} and ${currentRole} in ${roleIn(RLS_ROLES.attendeeRead)}`,
    }),
  ],
);

// ---------------------------------------------------------------------------
// event_analytics_vectors — RAG store. Written by server jobs only; browser roles can read their
// tenant's rows. A client must never be able to write an economic-impact figure into a report source.
// ---------------------------------------------------------------------------

export const EMBEDDING_DIMENSIONS = 1536;

export const eventAnalyticsVectors = pgTable(
  "event_analytics_vectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    eventId: uuid("event_id").notNull(),
    impactLevel: impactLevel("impact_level").notNull().default("insufficient_data"),
    /** TRY. Present only when the impact model reached `economic_impact` (CHECK). */
    netEconomicImpact: numeric("net_economic_impact", { precision: 18, scale: 2 }),
    /** Version of the methodology/engine that produced the figure — required whenever a figure exists. */
    impactMethodologyVersion: text("impact_methodology_version"),
    aiSummaryText: text("ai_summary_text").notNull(),
    /** Model that produced `embedding`; vectors from different models are not comparable. */
    embeddingModel: text("embedding_model").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_analytics_vectors_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    index("event_analytics_vectors_organization_id_idx").on(t.organizationId),
    index("event_analytics_vectors_event_id_idx").on(t.eventId),
    index("event_analytics_vectors_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check(
      "event_analytics_vectors_impact_requires_level",
      sql`${t.netEconomicImpact} is null or (${t.impactLevel} = 'economic_impact' and ${t.impactMethodologyVersion} is not null)`,
    ),
    check("event_analytics_vectors_summary_not_blank", sql`length(trim(${t.aiSummaryText})) > 0`),
    pgPolicy("event_analytics_vectors_select_own_org", {
      for: "select",
      to: authenticatedRole,
      using: sql`${t.organizationId} = ${currentOrg}`,
    }),
  ],
);

// ===========================================================================
// Planning & AI Blueprint (V0.1)
//
// Write model: the AI never writes `tasks`, `event_kpis` or `survey_questions` directly. It writes a
// `proposals` row (server only); applying an approved proposal is server code that copies the
// payload into these tables. Browser roles: SELECT their tenant's rows; the only client write is a
// task's status (column-level GRANT in migration 0003 + RLS policy).
// ===========================================================================

// EXPIRED (0004): a PENDING proposal past expires_at that someone tried to apply.
// NOTE: values added by 0004 must not be used as enum literals in 0004 itself — drizzle's migrator runs
// all pending migrations in ONE transaction, and Postgres forbids using a new enum value before commit.
export const proposalStatus = pgEnum("proposal_status", ["PENDING", "APPROVED", "REJECTED", "FAILED", "EXPIRED"]);
export const taskStatus = pgEnum("task_status", ["TODO", "IN_PROGRESS", "DONE"]);
export const kpiDataSource = pgEnum("kpi_data_source", ["survey", "ticket_sales", "system"]);
/**
 * Coarse display types (text/rating/boolean) for questions people add, plus (0004) the exact answer
 * formats of the metric question bank, which the KPI and impact pipelines read.
 */
export const surveyQuestionType = pgEnum("survey_question_type", ["text", "rating", "boolean", ...SURVEY_QUESTION_TYPES]);

// 0004 — Blueprint port
export const taskBoard = pgEnum("task_board", TASK_BOARDS);
export const taskPriority = pgEnum("task_priority", TASK_PRIORITIES);
export const eventPhase = pgEnum("event_phase", EVENT_PHASES);
export const kpiStatus = pgEnum("kpi_status", ["PROPOSED", "ACTIVE", "DROPPED"]);
export const surveyAudience = pgEnum("survey_audience", SURVEY_AUDIENCES);
export const aiGenerationStatus = pgEnum("ai_generation_status", [
  "STREAMING",
  "SUCCEEDED",
  "FAILED_VALIDATION",
  "FAILED_PROVIDER",
  "APPLIED",
]);

/** SELECT only, own tenant. */
const tenantReadPolicy = (table: string, orgCol: AnyPgColumn | SQLWrapper) =>
  pgPolicy(`${table}_select_own_org`, { for: "select", to: authenticatedRole, using: sql`${orgCol} = ${currentOrg}` });

/** sha256 hex — the fingerprint of the AI-written content. */
const fingerprint = (name: string) => char(name, { length: 64 });
const isHexFingerprint = (col: AnyPgColumn) => sql`${col} is null or ${col} ~ '^[0-9a-f]{64}$'`;

// ---------------------------------------------------------------------------
// ai_generations (0004) — audit trail of every LLM call. Server-only writes; members read their tenant's.
// ---------------------------------------------------------------------------

export const aiGenerations = pgTable(
  "ai_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null until the generation's proposal is applied to (or creates) an event. */
    eventId: uuid("event_id"),
    /** Null only after the person was deleted (column-scoped SET NULL, hand-written part of 0004). */
    requestedBy: uuid("requested_by"),
    /** "blueprint.core" | "blueprint.<section>" | "event_config" | "event_config_patch" | … */
    kind: text("kind").notNull(),
    prompt: text("prompt").notNull(),
    /** Prior config when the organizer refines an existing one. */
    baseConfig: jsonb("base_config"),
    output: jsonb("output"),
    validationErrors: jsonb("validation_errors"),
    schemaVersion: text("schema_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    temperature: numeric("temperature", { precision: 3, scale: 2 }).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    status: aiGenerationStatus("status").notNull().default("STREAMING"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of proposals.generation_id composite FK.
    unique("ai_generations_id_organization_id_uq").on(t.id, t.organizationId),
    foreignKey({
      name: "ai_generations_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "ai_generations_requested_by_same_org_fk",
      columns: [t.requestedBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("ai_generations_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("ai_generations_event_id_idx").on(t.eventId),
    check("ai_generations_kind_format", sql`${t.kind} ~ '^[a-z_]+(\\.[a-z_]+)?$'`),
    check("ai_generations_schema_version_not_blank", sql`length(trim(${t.schemaVersion})) > 0`),
    check("ai_generations_temperature_range", sql`${t.temperature} >= 0 and ${t.temperature} <= 2`),
    tenantReadPolicy("ai_generations", t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// proposals — human-in-the-loop AI drafts. Server-only writes.
// ---------------------------------------------------------------------------

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Null for a `blueprint.core` proposal: the event is created when that proposal is applied (0004).
     * MATCH SIMPLE: the same-organization FK is checked whenever event_id is set.
     */
    eventId: uuid("event_id"),
    status: proposalStatus("status").notNull().default("PENDING"),
    /** "blueprint.core" | "blueprint.tasks" | … | "copilot.update_task" (0004). */
    kind: text("kind").notNull(),
    /** One line shown on the approval card (0004). */
    title: text("title").notNull(),
    rationale: text("rationale"),
    /** Version of the operations contract, e.g. "blueprint/v1" (0004). */
    schemaVersion: text("schema_version").notNull(),
    /** The ai_generations row that produced this proposal (0004). */
    generationId: uuid("generation_id"),
    /** Who triggered the generation (0004). Null only after that person was deleted. */
    requestedBy: uuid("requested_by"),
    /** Optimistic-concurrency marker: events.updated_at the proposal was computed against (0004). */
    baseVersion: text("base_version"),
    /**
     * `{ operations: ProposalOperation[] }` — the validated operations the AI proposed (Zod-checked
     * before insert and again before apply).
     */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /**
     * sha256 of the canonical payload: identifies the proposal's content (it can be used to recognise an
     * identical regeneration; nothing does that yet). It is NOT copied onto the rows the proposal creates. Each AI-written row (tasks,
     * event_kpis, survey_questions, surveys) stores its own ai_fingerprint, computed from that row's own
     * AI-written fields, so a later regeneration can tell whether a person changed the row.
     */
    aiFingerprint: fingerprint("ai_fingerprint").notNull(),
    /** Audit: who approved or rejected, and when. */
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    /** Operation indexes the organizer kept ticked when applying; null = all (0004). */
    appliedOps: jsonb("applied_ops").$type<number[]>(),
    /** What the apply did: { created, updated, preserved } counts per entity (0004). */
    appliedSummary: jsonb("applied_summary").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique("proposals_id_organization_id_uq").on(t.id, t.organizationId),
    foreignKey({
      name: "proposals_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    // ON DELETE SET NULL (decided_by) only — see migration 0003. Deleting a person (KVKK erasure) must
    // not be blocked by audit rows; decided_at remains as evidence that a human decided.
    foreignKey({
      name: "proposals_decided_by_same_org_fk",
      columns: [t.decidedBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    // Column-scoped ON DELETE SET NULL for the two FKs below: hand-written part of 0004.
    foreignKey({
      name: "proposals_generation_same_org_fk",
      columns: [t.generationId, t.organizationId],
      foreignColumns: [aiGenerations.id, aiGenerations.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "proposals_requested_by_same_org_fk",
      columns: [t.requestedBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("proposals_org_event_status_idx").on(t.organizationId, t.eventId, t.status),
    index("proposals_generation_id_idx").on(t.generationId),
    check("proposals_payload_is_object", sql`jsonb_typeof(${t.payload}) = 'object'`),
    check("proposals_kind_format", sql`${t.kind} ~ '^[a-z_]+\\.[a-z_]+$'`),
    check("proposals_title_not_blank", sql`length(trim(${t.title})) > 0`),
    check("proposals_schema_version_not_blank", sql`length(trim(${t.schemaVersion})) > 0`),
    check("proposals_applied_ops_is_array", sql`${t.appliedOps} is null or jsonb_typeof(${t.appliedOps}) = 'array'`),
    check("proposals_applied_summary_is_object", sql`${t.appliedSummary} is null or jsonb_typeof(${t.appliedSummary}) = 'object'`),
    check("proposals_fingerprint_hex", sql`${t.aiFingerprint} ~ '^[0-9a-f]{64}$'`),
    check("proposals_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    // A decision always has a time; decided_by is set by the server at decision time and may later
    // become NULL only through user deletion.
    check("proposals_decision_recorded", sql`(${t.status} in ('APPROVED', 'REJECTED')) = (${t.decidedAt} is not null)`),
    check("proposals_failed_has_reason", sql`${t.status} <> 'FAILED' or ${t.errorMessage} is not null`),
    tenantReadPolicy("proposals", t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// tasks — logistics checklist. Clients may change `status` only.
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    proposalId: uuid("proposal_id"),
    title: varchar("title", { length: 200 }).notNull(),
    status: taskStatus("status").notNull().default("TODO"),
    assignedTo: uuid("assigned_to"),
    isAiGenerated: boolean("is_ai_generated").notNull().default(false),
    /**
     * sha256 of the fields the AI last wrote. On regeneration the server overwrites a task only if its
     * current fields still hash to this value — i.e. no person edited it — and never touches a DONE
     * task. NULL for tasks created by people.
     */
    aiFingerprint: fingerprint("ai_fingerprint"),
    // 0004 — Blueprint task plan. Server-written; clients still may update `status` only (0003 grants).
    /** Stable key from the Blueprint; unique per event so a regenerated plan updates instead of duplicating. */
    blueprintKey: text("blueprint_key"),
    description: text("description"),
    /** Workstream key from the module registry, e.g. "venue", "data_collection". */
    workstream: text("workstream"),
    board: taskBoard("board").notNull().default("PLANNING"),
    phase: eventPhase("phase").notNull().default("PLAN"),
    priority: taskPriority("priority").notNull().default("MEDIUM"),
    /** Days relative to event day 0 (negative = before). Kept so the plan re-flows when the date moves. */
    dueOffsetDays: integer("due_offset_days"),
    /** Materialised from events.start_date + due_offset_days, or set by a person. */
    dueDate: date("due_date"),
    /** Role placeholder until a person is assigned, e.g. "Proje yöneticisi". */
    assigneeRole: text("assignee_role"),
    /** Task ids in the same event this one waits on (resolved by the server from Blueprint keys). */
    dependsOn: uuid("depends_on").array().notNull().default(sql`'{}'::uuid[]`),
    /** Kanban order within (board, status): fractional index string. */
    position: text("position"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "tasks_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    // MATCH SIMPLE: when proposal_id / assigned_to is NULL the FK is not checked; when set, the
    // referenced proposal / user must belong to the same organization. Migration 0003 narrows
    // ON DELETE SET NULL to the nullable column (a plain SET NULL would also null organization_id).
    foreignKey({
      name: "tasks_proposal_same_org_fk",
      columns: [t.proposalId, t.organizationId],
      foreignColumns: [proposals.id, proposals.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "tasks_assignee_same_org_fk",
      columns: [t.assignedTo, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("tasks_org_event_status_idx").on(t.organizationId, t.eventId, t.status),
    index("tasks_assigned_to_idx").on(t.assignedTo),
    index("tasks_proposal_id_idx").on(t.proposalId),
    check("tasks_title_not_blank", sql`length(trim(${t.title})) > 0`),
    check("tasks_ai_fingerprint_only_for_ai", sql`${t.aiFingerprint} is null or ${t.isAiGenerated}`),
    unique("tasks_event_blueprint_key_uq").on(t.eventId, t.blueprintKey),
    check("tasks_blueprint_key_only_for_ai", sql`${t.blueprintKey} is null or ${t.isAiGenerated}`),
    check("tasks_blueprint_key_format", sql`${t.blueprintKey} is null or ${t.blueprintKey} ~ '^[a-z][a-z0-9_]{1,47}$'`),
    check("tasks_workstream_format", sql`${t.workstream} is null or ${t.workstream} ~ '^[a-z][a-z0-9_]{1,47}$'`),
    check("tasks_due_offset_range", sql`${t.dueOffsetDays} is null or ${t.dueOffsetDays} between -730 and 180`),
    index("tasks_org_event_due_idx").on(t.organizationId, t.eventId, t.dueDate),
    tenantReadPolicy("tasks", t.organizationId),
    pgPolicy("tasks_update_status_own_org", {
      for: "update",
      to: authenticatedRole,
      using: sql`${t.organizationId} = ${currentOrg}`,
      withCheck: sql`${t.organizationId} = ${currentOrg}`,
    }),
  ],
);

// ---------------------------------------------------------------------------
// event_kpis — measurement targets. Server-only writes.
// ---------------------------------------------------------------------------

export const eventKpis = pgTable(
  "event_kpis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    /** Machine key, e.g. 'nps', 'net_economic_impact'. Validate against the metric library in server code. */
    metricName: varchar("metric_name", { length: 64 }).notNull(),
    /**
     * Nullable since 0004: "measure, no target yet". The Blueprint sets a target only when the
     * organizer's own words support it; it never invents one.
     */
    targetValue: numeric("target_value", { precision: 18, scale: 4 }),
    actualValue: numeric("actual_value", { precision: 18, scale: 4 }),
    dataSource: kpiDataSource("data_source").notNull(),
    // 0004 — Blueprint KPI plan
    /** PROPOSED until the organizer activates or drops it; non-PROPOSED KPIs are never rewritten by the AI. */
    status: kpiStatus("status").notNull().default("PROPOSED"),
    /** Version of the metric definition the KPI was created against. */
    metricVersion: integer("metric_version").notNull().default(1),
    /** Index into the event's objectives (events.ai_config.objectives) this KPI measures. */
    objectiveIndex: integer("objective_index"),
    rationale: text("rationale"),
    /** sha256 of the fields the AI last wrote; see tasks.ai_fingerprint. */
    aiFingerprint: fingerprint("ai_fingerprint"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_kpis_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    unique("event_kpis_event_metric_uq").on(t.eventId, t.metricName),
    index("event_kpis_organization_id_idx").on(t.organizationId),
    check("event_kpis_metric_name_format", sql`${t.metricName} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check("event_kpis_metric_version_positive", sql`${t.metricVersion} >= 1`),
    check("event_kpis_objective_index_non_negative", sql`${t.objectiveIndex} is null or ${t.objectiveIndex} >= 0`),
    check("event_kpis_ai_fingerprint_hex", isHexFingerprint(t.aiFingerprint)),
    tenantReadPolicy("event_kpis", t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// survey_questions — dynamic DSS questions. Server-only writes (AI drafts arrive via proposals).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// surveys (0005) — survey header: one row per (event, audience, version). Server-only writes.
// An OPEN or CLOSED survey is never rewritten by the AI; a regenerated plan opens a new DRAFT version.
// ---------------------------------------------------------------------------

export const surveyStatus = pgEnum("survey_status", ["DRAFT", "OPEN", "CLOSED"]);

export const surveys = pgTable(
  "surveys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    audience: surveyAudience("audience").notNull(),
    version: integer("version").notNull().default(1),
    status: surveyStatus("status").notNull().default("DRAFT"),
    title: text("title").notNull(),
    /** Text shown to respondents before the first question (purpose, approximate duration). */
    intro: text("intro"),
    targetResponses: integer("target_responses"),
    isAiGenerated: boolean("is_ai_generated").notNull().default(false),
    /** Stable Blueprint key, e.g. "survey_attendee". */
    blueprintKey: text("blueprint_key"),
    /**
     * sha256 of the PERSISTED survey: title, intro, target_responses and every question row (in
     * position order) as stored. The AI may rewrite a DRAFT survey only while this still matches.
     */
    aiFingerprint: fingerprint("ai_fingerprint"),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    /**
     * Public link token (0007), set when the survey is opened. Anyone holding it can submit an anonymous
     * response while the survey is OPEN; it grants nothing else.
     */
    publicToken: text("public_token"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("surveys_public_token_uq").on(t.publicToken),
    check("surveys_public_token_format", sql`${t.publicToken} is null or ${t.publicToken} ~ '^[A-Za-z0-9_-]{32,64}$'`),
    foreignKey({
      name: "surveys_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    unique("surveys_event_audience_version_uq").on(t.eventId, t.audience, t.version),
    // Target of survey_questions' FK: a question can only belong to a survey of the same org, event and audience.
    unique("surveys_id_scope_uq").on(t.id, t.organizationId, t.eventId, t.audience),
    index("surveys_org_event_idx").on(t.organizationId, t.eventId),
    check("surveys_title_not_blank", sql`length(trim(${t.title})) > 0`),
    check("surveys_version_positive", sql`${t.version} >= 1`),
    check("surveys_target_responses_positive", sql`${t.targetResponses} is null or ${t.targetResponses} > 0`),
    check("surveys_blueprint_key_only_for_ai", sql`${t.blueprintKey} is null or ${t.isAiGenerated}`),
    check("surveys_blueprint_key_format", sql`${t.blueprintKey} is null or ${t.blueprintKey} ~ '^survey_[a-z_]{1,40}$'`),
    check("surveys_ai_fingerprint_only_for_ai", sql`${t.aiFingerprint} is null or ${t.isAiGenerated}`),
    check("surveys_ai_fingerprint_hex", isHexFingerprint(t.aiFingerprint)),
    check("surveys_window_ordered", sql`${t.closesAt} is null or ${t.opensAt} is null or ${t.closesAt} > ${t.opensAt}`),
    tenantReadPolicy("surveys", t.organizationId),
  ],
);

export const surveyQuestions = pgTable(
  "survey_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    /** The survey (header + version) this question belongs to (0005). */
    surveyId: uuid("survey_id").notNull(),
    questionText: text("question_text").notNull(),
    type: surveyQuestionType("type").notNull(),
    isMandatory: boolean("is_mandatory").notNull().default(false),
    /** Display order within the survey. */
    position: integer("position").notNull().default(0),
    // 0004 — survey metadata the KPI and impact pipelines read
    /** Who answers: one survey per audience per event. */
    audience: surveyAudience("audience").notNull().default("ATTENDEE"),
    /** Stable key: q_* for question-bank items (fixed, read by the KPI engine), x_* for AI extras. */
    questionKey: text("question_key"),
    /** [{ value, label }] for choice questions. */
    options: jsonb("options").$type<{ value: string; label: string }[]>(),
    /** { measures, spendCategory, spendBasis, showIf, reverseCoded, helpText, origin } from the question bank. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** KVKK special-category data (health, accessibility); shown only after explicit consent. */
    isSensitive: boolean("is_sensitive").notNull().default(false),
    /**
     * sha256 of this question as stored (key, type, text, mandatory, options, sensitive, metadata). Kept for
     * audit; whether the AI may rewrite a survey is decided by surveys.ai_fingerprint, which covers all questions.
     */
    aiFingerprint: fingerprint("ai_fingerprint"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "survey_questions_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    index("survey_questions_org_event_position_idx").on(t.organizationId, t.eventId, t.position),
    check("survey_questions_text_not_blank", sql`length(trim(${t.questionText})) > 0`),
    check("survey_questions_position_non_negative", sql`${t.position} >= 0`),
    // 0005: keys are unique per survey version (was per event + audience in 0004).
    unique("survey_questions_survey_key_uq").on(t.surveyId, t.questionKey),
    foreignKey({
      name: "survey_questions_survey_same_scope_fk",
      columns: [t.surveyId, t.organizationId, t.eventId, t.audience],
      foreignColumns: [surveys.id, surveys.organizationId, surveys.eventId, surveys.audience],
    }).onDelete("cascade"),
    index("survey_questions_survey_position_idx").on(t.surveyId, t.position),
    check("survey_questions_key_format", sql`${t.questionKey} is null or ${t.questionKey} ~ '^(q|x)_[a-z0-9_]{1,46}$'`),
    check("survey_questions_options_is_array", sql`${t.options} is null or jsonb_typeof(${t.options}) = 'array'`),
    check("survey_questions_metadata_is_object", sql`jsonb_typeof(${t.metadata}) = 'object'`),
    // ::text on purpose — the choice types are enum values added by this same migration (see proposalStatus note).
    check(
      "survey_questions_choice_has_options",
      sql`${t.type}::text not in ('SINGLE_CHOICE', 'MULTI_CHOICE') or (${t.options} is not null and jsonb_array_length(${t.options}) >= 2)`,
    ),
    check("survey_questions_ai_fingerprint_hex", isHexFingerprint(t.aiFingerprint)),
    tenantReadPolicy("survey_questions", t.organizationId),
  ],
);

// ===========================================================================
// 0007 — survey responses and the impact calculation
// ===========================================================================

export const spendCategory = pgEnum("spend_category", SPEND_CATEGORIES);
export const surveyResponseChannel = pgEnum("survey_response_channel", ["PUBLIC_LINK", "STAFF_ENTRY"]);
/** How a multiplier set was regionalised (kept from the original design; recorded, not computed here). */
export const regionalizationMethod = pgEnum("regionalization_method", ["NATIONAL", "SLQ", "CILQ", "FLQ", "SURVEY_BASED"]);
/** TYPE_I: direct + indirect. TYPE_II: + induced (households endogenised). */
export const multiplierType = pgEnum("multiplier_type", ["TYPE_I", "TYPE_II"]);
export const impactRunStatus = pgEnum("impact_run_status", ["SUCCEEDED", "INSUFFICIENT_DATA"]);

/** Owner/admin of the row's organization (SELECT policy for tables holding raw answers). */
const tenantRoleReadPolicy = (table: string, orgCol: AnyPgColumn, roles: readonly string[]) =>
  pgPolicy(`${table}_select_own_org`, {
    for: "select",
    to: authenticatedRole,
    using: sql`${orgCol} = ${currentOrg} and ${currentRole} in ${roleIn(roles)}`,
  });

// ---------------------------------------------------------------------------
// survey_responses — one anonymous submission of one survey version. Server-only writes.
// No respondent identity is stored (no name, contact, attendee link or device id): the MVP keeps
// survey data anonymous, so no consent record is needed here. The columns after `answers` are the
// normalised visitor profile the impact engine reads (extracted at submit time from question-bank keys).
// ---------------------------------------------------------------------------

export const surveyResponses = pgTable(
  "survey_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    surveyId: uuid("survey_id").notNull(),
    audience: surveyAudience("audience").notNull(),
    surveyVersion: integer("survey_version").notNull(),
    channel: surveyResponseChannel("channel").notNull(),
    /** Staff member who typed the answers in (STAFF_ENTRY). Null for public-link submissions. */
    enteredBy: uuid("entered_by"),
    /** Validated answers keyed by survey_questions.question_key. */
    answers: jsonb("answers").$type<Record<string, unknown>>().notNull(),
    /** q_is_local */
    isLocalResident: boolean("is_local_resident"),
    /** q_home_province: plate code 1–81, 0 = abroad. */
    homeProvinceCode: smallint("home_province_code"),
    /** q_party_size */
    partySize: smallint("party_size"),
    /** q_days_present */
    daysPresent: smallint("days_present"),
    /** q_nights_stayed */
    nightsStayed: smallint("nights_stayed"),
    /** q_main_reason: event | event_and_other | other */
    mainReason: text("main_reason"),
    /** q_would_visit_anyway: yes | maybe | no */
    wouldVisitAnyway: text("would_visit_anyway"),
    /** Non-response / quota weight. 1 = unweighted; nothing sets another value yet. */
    weight: numeric("weight", { precision: 10, scale: 4 }).notNull().default("1"),
    /** Excluded by a person (owner/admin) with a reason; excluded responses never enter a calculation. */
    isExcluded: boolean("is_excluded").notNull().default(false),
    exclusionReason: text("exclusion_reason"),
    excludedBy: uuid("excluded_by"),
    excludedAt: timestamp("excluded_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("survey_responses_id_organization_id_uq").on(t.id, t.organizationId),
    foreignKey({
      name: "survey_responses_survey_same_scope_fk",
      columns: [t.surveyId, t.organizationId, t.eventId, t.audience],
      foreignColumns: [surveys.id, surveys.organizationId, surveys.eventId, surveys.audience],
    }).onDelete("cascade"),
    // Column-scoped ON DELETE SET NULL (hand-written in 0007), like tasks.assigned_to.
    foreignKey({
      name: "survey_responses_entered_by_same_org_fk",
      columns: [t.enteredBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "survey_responses_excluded_by_same_org_fk",
      columns: [t.excludedBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("survey_responses_org_event_idx").on(t.organizationId, t.eventId),
    index("survey_responses_survey_idx").on(t.surveyId),
    check("survey_responses_answers_is_object", sql`jsonb_typeof(${t.answers}) = 'object'`),
    check("survey_responses_version_positive", sql`${t.surveyVersion} >= 1`),
    check("survey_responses_weight_positive", sql`${t.weight} > 0`),
    check("survey_responses_province_range", sql`${t.homeProvinceCode} is null or ${t.homeProvinceCode} between 0 and 81`),
    check("survey_responses_party_size_range", sql`${t.partySize} is null or ${t.partySize} between 1 and 500`),
    check("survey_responses_days_range", sql`${t.daysPresent} is null or ${t.daysPresent} between 1 and 366`),
    check("survey_responses_nights_range", sql`${t.nightsStayed} is null or ${t.nightsStayed} between 0 and 366`),
    check("survey_responses_main_reason_values", sql`${t.mainReason} is null or ${t.mainReason} in ('event', 'event_and_other', 'other')`),
    check("survey_responses_visit_anyway_values", sql`${t.wouldVisitAnyway} is null or ${t.wouldVisitAnyway} in ('yes', 'maybe', 'no')`),
    check("survey_responses_exclusion_has_reason",
      sql`${t.isExcluded} = (${t.exclusionReason} is not null) and (${t.exclusionReason} is null or length(trim(${t.exclusionReason})) > 0)`),
    check("survey_responses_public_link_has_no_operator", sql`${t.channel} <> 'PUBLIC_LINK' or ${t.enteredBy} is null`),
    tenantRoleReadPolicy("survey_responses", t.organizationId, RLS_ROLES.surveyResponseRead),
  ],
);

/** One spend line per response and category, in kuruş, for the respondent's party and whole stay. */
export const surveyResponseSpend = pgTable(
  "survey_response_spend",
  {
    responseId: uuid("response_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    category: spendCategory("category").notNull(),
    amountKurus: bigint("amount_kurus", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ name: "survey_response_spend_pk", columns: [t.responseId, t.category] }),
    foreignKey({
      name: "survey_response_spend_response_same_org_fk",
      columns: [t.responseId, t.organizationId],
      foreignColumns: [surveyResponses.id, surveyResponses.organizationId],
    }).onDelete("cascade"),
    index("survey_response_spend_organization_id_idx").on(t.organizationId),
    check("survey_response_spend_amount_range", sql`${t.amountKurus} >= 0 and ${t.amountKurus} <= 100000000000`),
    tenantRoleReadPolicy("survey_response_spend", t.organizationId, RLS_ROLES.surveyResponseRead),
  ],
);

// ---------------------------------------------------------------------------
// multiplier_sets / multipliers — input-output multipliers entered by the organization with their
// source. The platform ships none: every coefficient is the organization's recorded, cited input.
// ---------------------------------------------------------------------------

export const multiplierSets = pgTable(
  "multiplier_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Dataset citation, e.g. the TÜİK table and the regionalisation output it came from. */
    source: text("source").notNull(),
    ioBaseYear: smallint("io_base_year").notNull(),
    priceYear: smallint("price_year").notNull(),
    /** NUTS-2 region the set was regionalised for; null = national table. */
    nuts2Code: varchar("nuts2_code", { length: 4 }),
    method: regionalizationMethod("method").notNull(),
    multiplierType: multiplierType("multiplier_type").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    unique("multiplier_sets_id_organization_id_uq").on(t.id, t.organizationId),
    foreignKey({
      name: "multiplier_sets_created_by_same_org_fk",
      columns: [t.createdBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("multiplier_sets_organization_id_idx").on(t.organizationId),
    check("multiplier_sets_name_not_blank", sql`length(trim(${t.name})) > 0`),
    check("multiplier_sets_source_given", sql`length(trim(${t.source})) >= 10`),
    check("multiplier_sets_years_range", sql`${t.ioBaseYear} between 1990 and 2100 and ${t.priceYear} between 1990 and 2100`),
    check("multiplier_sets_nuts2_format", sql`${t.nuts2Code} is null or ${t.nuts2Code} ~ '^TR[1-9A-C][0-9]$'`),
    check("multiplier_sets_national_method", sql`(${t.nuts2Code} is null) = (${t.method} = 'NATIONAL')`),
    tenantReadPolicy("multiplier_sets", t.organizationId),
  ],
);

/** Coefficients per unit of final demand in one spend category. */
export const multipliers = pgTable(
  "multipliers",
  {
    setId: uuid("set_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    spendCategory: spendCategory("spend_category").notNull(),
    /** A-64 sector the category was mapped to (documentation of the source; not used in the arithmetic). */
    a64Code: varchar("a64_code", { length: 16 }),
    output: numeric("output", { precision: 10, scale: 6 }).notNull(),
    valueAdded: numeric("value_added", { precision: 10, scale: 6 }).notNull(),
    income: numeric("income", { precision: 10, scale: 6 }).notNull(),
    /**
     * Jobs (FTE) per 1,000,000 TRY of final demand at the set's price year. 0010: nullable — sets derived from
     * TÜİK's input-output tables have no employment coefficient (the tables carry none); never invented.
     */
    employmentPerMTry: numeric("employment_per_m_try", { precision: 10, scale: 6 }),
  },
  (t) => [
    primaryKey({ name: "multipliers_pk", columns: [t.setId, t.spendCategory] }),
    foreignKey({
      name: "multipliers_set_same_org_fk",
      columns: [t.setId, t.organizationId],
      foreignColumns: [multiplierSets.id, multiplierSets.organizationId],
    }).onDelete("cascade"),
    index("multipliers_organization_id_idx").on(t.organizationId),
    check("multipliers_non_negative",
      sql`${t.output} >= 0 and ${t.valueAdded} >= 0 and ${t.income} >= 0 and (${t.employmentPerMTry} is null or ${t.employmentPerMTry} >= 0)`),
    tenantReadPolicy("multipliers", t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// budget_items (0012) — an event's planned and actual income and costs (KPI reference §3.4, §3.10). Server-only:
// RLS on, a SELECT policy for owner/admin of the organization (RLS_ROLES.budgetRead), no browser privilege.
// ---------------------------------------------------------------------------

const inList = (col: AnyPgColumn, values: readonly string[]) => sql`${col} in ${sql.raw(`(${values.map((v) => `'${v}'`).join(", ")})`)}`;

export const budgetItems = pgTable(
  "budget_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    /** INCOME | COST | TICKET_ADJUSTMENT (src/lib/budget/categories.ts). */
    kind: text("kind").notNull(),
    category: text("category").notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    plannedKurus: bigint("planned_kurus", { mode: "number" }),
    actualKurus: bigint("actual_kurus", { mode: "number" }),
    /** Paid tickets behind a TICKETS income line (average ticket price). */
    quantity: integer("quantity"),
    /** COST only: FIXED | VARIABLE (break-even point). */
    costBehavior: text("cost_behavior"),
    /** COST only: the supplier is in the event's region (organizer local spend, §3.10). */
    supplierLocal: boolean("supplier_local"),
    /** COST only: paid from money that comes from outside the region (organizer local spend, §3.10). */
    fundedExternally: boolean("funded_externally"),
    notes: text("notes"),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "budget_items_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "budget_items_created_by_same_org_fk",
      columns: [t.createdBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("budget_items_event_idx").on(t.organizationId, t.eventId),
    check("budget_items_kind_category", sql`(${t.kind} = 'INCOME' and ${inList(t.category, BUDGET_CATEGORIES.INCOME)})
      or (${t.kind} = 'COST' and ${inList(t.category, BUDGET_CATEGORIES.COST)})
      or (${t.kind} = 'TICKET_ADJUSTMENT' and ${inList(t.category, BUDGET_CATEGORIES.TICKET_ADJUSTMENT)})`),
    check("budget_items_amounts", sql`(${t.plannedKurus} is not null or ${t.actualKurus} is not null)
      and (${t.plannedKurus} is null or ${t.plannedKurus} between 0 and ${sql.raw(String(MAX_BUDGET_KURUS))})
      and (${t.actualKurus} is null or ${t.actualKurus} between 0 and ${sql.raw(String(MAX_BUDGET_KURUS))})`),
    check("budget_items_label_not_blank", sql`length(trim(${t.label})) > 0`),
    check("budget_items_quantity", sql`${t.quantity} is null or (${t.kind} = 'INCOME' and ${t.category} = 'TICKETS' and ${t.quantity} >= 0)`),
    check("budget_items_cost_fields", sql`${t.kind} = 'COST' or (${t.costBehavior} is null and ${t.supplierLocal} is null and ${t.fundedExternally} is null)`),
    check("budget_items_cost_behavior", sql`${t.costBehavior} is null or ${t.costBehavior} in ('FIXED', 'VARIABLE')`),
    tenantRoleReadPolicy("budget_items", t.organizationId, RLS_ROLES.budgetRead),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// External data (0013) — per-event sources pulled from outside services (src/lib/connectors/providers.ts), the
// observations they produced, press-mention candidates a person verifies, and sponsor / lead lists uploaded as
// CSV. All server-only (explicit-grant model): RLS on, a SELECT policy, no browser privilege. Credentials of the
// services live in the server environment, never here.
// ---------------------------------------------------------------------------

export const eventDataSources = pgTable(
  "event_data_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    /** OPEN_METEO_AIR | BREVO | GA4 | META | YOUTUBE | NEWS */
    provider: text("provider").notNull(),
    /** Validated per provider (PROVIDER_CONFIG); identifiers and search terms only, no secrets. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** 0017: automatic pull interval in minutes chosen for this source; null = provider default, 0 = automatic pulls off. */
    syncIntervalMinutes: integer("sync_interval_minutes"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** OK | ERROR of the last pull; the error text is for the organizer (no secret is ever echoed). */
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    /** One line on what the last successful pull read. */
    lastSummary: text("last_summary"),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_data_sources_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "event_data_sources_created_by_same_org_fk",
      columns: [t.createdBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    unique("event_data_sources_id_org_uq").on(t.id, t.organizationId),
    uniqueIndex("event_data_sources_event_provider_uq").on(t.eventId, t.provider),
    check("event_data_sources_provider", sql`${t.provider} in ('OPEN_METEO_AIR', 'BREVO', 'GA4', 'META', 'YOUTUBE', 'NEWS')`),
    check("event_data_sources_config_object", sql`jsonb_typeof(${t.config}) = 'object'`),
    check("event_data_sources_status", sql`${t.lastStatus} is null or ${t.lastStatus} in ('OK', 'ERROR')`),
    check("event_data_sources_sync_interval", sql`${t.syncIntervalMinutes} is null or ${t.syncIntervalMinutes} = 0 or ${t.syncIntervalMinutes} between 15 and 4320`),
    tenantReadPolicy("event_data_sources", t.organizationId),
  ],
).enableRLS();

/**
 * One value a source reported, keyed by (source, key, dimension): e.g. ("email.delivered", "campaign:12"),
 * ("social.reach", "instagram:1789…"), ("air.pm2_5", "2026-10-22T14:00"). A pull upserts, so values accumulate
 * across pulls (Instagram hashtag search only returns the last 24 hours) and a re-pull updates them.
 */
export const dataObservations = pgTable(
  "data_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    key: varchar("key", { length: 64 }).notNull(),
    dimension: varchar("dimension", { length: 200 }).notNull().default(""),
    value: doublePrecision("value").notNull(),
    /** When the observed thing happened (post time, hour of an air reading), if it has one. */
    observedAt: timestamp("observed_at", { withTimezone: true }),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "data_observations_source_same_org_fk",
      columns: [t.sourceId, t.organizationId],
      foreignColumns: [eventDataSources.id, eventDataSources.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "data_observations_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("data_observations_source_key_dim_uq").on(t.sourceId, t.key, t.dimension),
    index("data_observations_event_idx").on(t.organizationId, t.eventId),
    // PostgreSQL treats NaN as equal to itself, so it is excluded by name.
    check("data_observations_value_finite", sql`${t.value} not in ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)`),
    tenantReadPolicy("data_observations", t.organizationId),
  ],
).enableRLS();

/** Press coverage: candidates found by the news search (or added by hand); only VERIFIED ones are counted. */
export const mediaMentions = pgTable(
  "media_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    domain: varchar("domain", { length: 255 }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** GDELT | GOOGLE_NEWS | MANUAL */
    foundBy: text("found_by").notNull(),
    /** CANDIDATE | VERIFIED | REJECTED */
    status: text("status").notNull().default("CANDIDATE"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "media_mentions_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "media_mentions_reviewed_by_same_org_fk",
      columns: [t.reviewedBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    uniqueIndex("media_mentions_event_url_uq").on(t.eventId, t.url),
    index("media_mentions_event_idx").on(t.organizationId, t.eventId),
    check("media_mentions_url_http", sql`${t.url} ~ '^https?://'`),
    check("media_mentions_found_by", sql`${t.foundBy} in ('GDELT', 'GOOGLE_NEWS', 'MANUAL')`),
    check("media_mentions_status", sql`${t.status} in ('CANDIDATE', 'VERIFIED', 'REJECTED')`),
    check("media_mentions_reviewed", sql`(${t.status} = 'CANDIDATE') = (${t.reviewedAt} is null)`),
    tenantReadPolicy("media_mentions", t.organizationId),
  ],
).enableRLS();

/** Sponsors of an event (and of its previous edition, for the renewal rate), uploaded as CSV. Owner/admin only. */
export const eventSponsors = pgTable(
  "event_sponsors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    /** Sponsor of this edition / of the previous one. */
    currentEdition: boolean("current_edition").notNull(),
    previousEdition: boolean("previous_edition").notNull(),
    /** What the sponsorship cost the sponsor (TRY, kuruş). */
    costKurus: bigint("cost_kurus", { mode: "number" }),
    /** Value attributed to the sponsor, as agreed with the sponsor beforehand (KPI reference §3.4). */
    attributedValueKurus: bigint("attributed_value_kurus", { mode: "number" }),
    impressions: bigint("impressions", { mode: "number" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_sponsors_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    index("event_sponsors_event_idx").on(t.organizationId, t.eventId),
    check("event_sponsors_edition", sql`${t.currentEdition} or ${t.previousEdition}`),
    check("event_sponsors_amounts", sql`(${t.costKurus} is null or ${t.costKurus} between 0 and ${sql.raw(String(MAX_BUDGET_KURUS))})
      and (${t.attributedValueKurus} is null or ${t.attributedValueKurus} between 0 and ${sql.raw(String(MAX_BUDGET_KURUS))})
      and (${t.impressions} is null or ${t.impressions} >= 0)`),
    check("event_sponsors_name_not_blank", sql`length(trim(${t.name})) > 0`),
    tenantRoleReadPolicy("event_sponsors", t.organizationId, RLS_ROLES.budgetRead),
  ],
).enableRLS();

/**
 * Leads collected at stands, uploaded as CSV. Pseudonymous: an external id from the exhibitor's tool, never a
 * name, e-mail or phone (the upload drops such columns). Owner/admin only.
 */
export const eventLeads = pgTable(
  "event_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    externalId: varchar("external_id", { length: 100 }).notNull(),
    exhibitor: varchar("exhibitor", { length: 200 }),
    /** The person agreed to be contacted (KVKK). */
    consent: boolean("consent").notNull(),
    qualified: boolean("qualified").notNull(),
    opportunity: boolean("opportunity").notNull(),
    opportunityValueKurus: bigint("opportunity_value_kurus", { mode: "number" }),
    /** Won revenue attributed to the event under the organization's attribution rule (window, multi-touch). */
    wonRevenueKurus: bigint("won_revenue_kurus", { mode: "number" }),
    boothMinutes: doublePrecision("booth_minutes"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_leads_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("event_leads_event_external_uq").on(t.eventId, t.externalId),
    index("event_leads_event_idx").on(t.organizationId, t.eventId),
    check("event_leads_amounts", sql`(${t.opportunityValueKurus} is null or ${t.opportunityValueKurus} between 0 and ${sql.raw(String(MAX_BUDGET_KURUS))})
      and (${t.wonRevenueKurus} is null or ${t.wonRevenueKurus} between 0 and ${sql.raw(String(MAX_BUDGET_KURUS))})
      and (${t.boothMinutes} is null or ${t.boothMinutes} between 0 and 1440)`),
    check("event_leads_opportunity_value", sql`${t.opportunity} or ${t.opportunityValueKurus} is null`),
    tenantRoleReadPolicy("event_leads", t.organizationId, RLS_ROLES.budgetRead),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// event_datasets (0014) — the organization's own tables (Excel / CSV) uploaded for an event: typed columns, rows
// (personal-data columns removed at upload), the column mapping a person confirmed, and the model's written
// interpretation of the computed figures. Server-only: RLS on, a SELECT policy, no browser privilege.
// ---------------------------------------------------------------------------

export const eventDatasets = pgTable(
  "event_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    sheetName: varchar("sheet_name", { length: 120 }),
    /** NEEDS_REVIEW until a person confirms the column mapping; only CONFIRMED tables feed metrics. */
    status: text("status").notNull().default("NEEDS_REVIEW"),
    columns: jsonb("columns").$type<unknown[]>().notNull(),
    rows: jsonb("rows").$type<unknown[]>().notNull(),
    rowCount: integer("row_count").notNull(),
    headerRow: integer("header_row").notNull(),
    droppedColumns: jsonb("dropped_columns").$type<unknown[]>().notNull(),
    mapping: jsonb("mapping").$type<unknown[]>().notNull(),
    /** Model call behind the mapping suggestions, if any: { model, at, generationId }. */
    suggestedBy: jsonb("suggested_by").$type<Record<string, unknown>>(),
    /** { text, model, at, generationId, basis } — written from the computed figures, regenerated on demand. */
    interpretation: jsonb("interpretation").$type<Record<string, unknown>>(),
    createdBy: uuid("created_by"),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_datasets_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "event_datasets_created_by_same_org_fk",
      columns: [t.createdBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "event_datasets_confirmed_by_same_org_fk",
      columns: [t.confirmedBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("event_datasets_event_idx").on(t.organizationId, t.eventId),
    check("event_datasets_status", sql`${t.status} in ('NEEDS_REVIEW', 'CONFIRMED')`),
    check("event_datasets_confirmed", sql`(${t.status} = 'CONFIRMED') = (${t.confirmedAt} is not null)`),
    check("event_datasets_json_arrays", sql`jsonb_typeof(${t.columns}) = 'array' and jsonb_typeof(${t.rows}) = 'array'
      and jsonb_typeof(${t.mapping}) = 'array' and jsonb_typeof(${t.droppedColumns}) = 'array'`),
    check("event_datasets_row_count", sql`${t.rowCount} between 0 and 20000 and ${t.rowCount} = jsonb_array_length(${t.rows})`),
    check("event_datasets_name_not_blank", sql`length(trim(${t.name})) > 0`),
    tenantReadPolicy("event_datasets", t.organizationId),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// event_survey_links (0015, 0016) — one public link (one QR code) per event for all of its surveys: the respondent first
// says in which role they took part; each option opens one or more audiences' surveys (like section branching in a form
// builder). The organizer may edit the first question and its options (0016).
// Responses are stored on that audience's survey as before. Server-only: RLS on, a SELECT policy, no browser privilege.
// ---------------------------------------------------------------------------

export const eventSurveyLinks = pgTable(
  "event_survey_links",
  {
    eventId: uuid("event_id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    /** 0016: the first question's text; null = the default ("Etkinliğe hangi rolle katıldınız?"). */
    roleQuestion: text("role_question"),
    /** 0016: answer options [{ key, label, audiences[] }] (src/lib/surveys/roles.ts); null = one per audience (defaults). */
    routes: jsonb("routes").$type<unknown[]>(),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_survey_links_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "event_survey_links_created_by_same_org_fk",
      columns: [t.createdBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    uniqueIndex("event_survey_links_token_uq").on(t.token),
    check("event_survey_links_token_format", sql`${t.token} ~ '^[A-Za-z0-9_-]{32,64}$'`),
    check("event_survey_links_routes_array", sql`${t.routes} is null or (jsonb_typeof(${t.routes}) = 'array' and jsonb_array_length(${t.routes}) between 1 and 12)`),
    check("event_survey_links_role_question_length", sql`${t.roleQuestion} is null or length(trim(${t.roleQuestion})) between 3 and 200`),
    tenantReadPolicy("event_survey_links", t.organizationId),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// event_impact_inputs — per event: price year, sourced adjustments and the multiplier set to use.
// Every adjustment is a (value, source) pair or absent; a value without a source cannot be stored.
// ---------------------------------------------------------------------------

export const eventImpactInputs = pgTable(
  "event_impact_inputs",
  {
    eventId: uuid("event_id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    priceYear: smallint("price_year").notNull(),
    /** SURVEY_STRICT (attendee survey, strict rule) | RECORDED_DEADWEIGHT (the deadweight pair below). */
    attributionMethod: text("attribution_method").notNull().default("SURVEY_STRICT"),
    deadweight: numeric("deadweight", { precision: 5, scale: 4 }),
    deadweightSource: text("deadweight_source"),
    displacement: numeric("displacement", { precision: 5, scale: 4 }),
    displacementSource: text("displacement_source"),
    leakage: numeric("leakage", { precision: 5, scale: 4 }),
    leakageSource: text("leakage_source"),
    multiplierSetId: uuid("multiplier_set_id"),
    updatedBy: uuid("updated_by"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_impact_inputs_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "event_impact_inputs_multiplier_set_same_org_fk",
      columns: [t.multiplierSetId, t.organizationId],
      foreignColumns: [multiplierSets.id, multiplierSets.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "event_impact_inputs_updated_by_same_org_fk",
      columns: [t.updatedBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("event_impact_inputs_organization_id_idx").on(t.organizationId),
    check("event_impact_inputs_price_year_range", sql`${t.priceYear} between 2000 and 2100`),
    check("event_impact_inputs_attribution_method",
      sql`${t.attributionMethod} in ('SURVEY_STRICT', 'RECORDED_DEADWEIGHT') and (${t.attributionMethod} <> 'RECORDED_DEADWEIGHT' or ${t.deadweight} is not null)`),
    ...(["deadweight", "displacement", "leakage"] as const).map((k) => {
      const v = t[k];
      const src = t[`${k}Source`];
      return check(`event_impact_inputs_${k}_sourced`,
        sql`(${v} is null) = (${src} is null) and (${v} is null or (${v} >= 0 and ${v} <= 1 and length(trim(${src})) >= 10))`);
    }),
    tenantReadPolicy("event_impact_inputs", t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// impact_calculation_runs — immutable record of one calculation (UPDATE is blocked by a trigger, 0007; the only
// exception is the triggered_by FK clearing the person when they are deleted).
// A report cites a run id, never live numbers. CHECKs make a figure impossible to store for a level the
// data did not reach.
// ---------------------------------------------------------------------------

const levelRank = (col: AnyPgColumn) =>
  sql`array_position(array['insufficient_data', 'spend', 'attributable_spend', 'economic_impact']::impact_level[], ${col})`;

export const impactCalculationRuns = pgTable(
  "impact_calculation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    requestedLevel: impactLevel("requested_level").notNull(),
    /** `insufficient_data` when not even the first level was reached. */
    achievedLevel: impactLevel("achieved_level").notNull(),
    status: impactRunStatus("status").notNull(),
    engineVersion: text("engine_version").notNull(),
    /** The gate's checks (what passed, what failed, required vs actual). */
    dataSufficiency: jsonb("data_sufficiency").notNull(),
    /** The inputs exactly as used: assumptions, multiplier set and coefficients, response counts, attendance. */
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull(),
    multiplierSetId: uuid("multiplier_set_id"),
    attendanceBasis: text("attendance_basis"),
    attendanceUsed: integer("attendance_used"),
    sampleSize: integer("sample_size").notNull(),
    // Figures in TRY at the run's price year.
    grossDirectSpend: numeric("gross_direct_spend", { precision: 18, scale: 2 }),
    attributableSpend: numeric("attributable_spend", { precision: 18, scale: 2 }),
    totalOutputImpact: numeric("total_output_impact", { precision: 18, scale: 2 }),
    totalValueAdded: numeric("total_value_added", { precision: 18, scale: 2 }),
    totalIncome: numeric("total_income", { precision: 18, scale: 2 }),
    totalEmploymentFte: numeric("total_employment_fte", { precision: 12, scale: 2 }),
    /** Intermediate values and the per-category breakdown. */
    breakdown: jsonb("breakdown").$type<Record<string, unknown>>(),
    triggeredBy: uuid("triggered_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "impact_calculation_runs_event_same_org_fk",
      columns: [t.eventId, t.organizationId],
      foreignColumns: [events.id, events.organizationId],
    }).onDelete("cascade"),
    // A set that a run used cannot be deleted (the run must stay reproducible).
    foreignKey({
      name: "impact_calculation_runs_multiplier_set_same_org_fk",
      columns: [t.multiplierSetId, t.organizationId],
      foreignColumns: [multiplierSets.id, multiplierSets.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "impact_calculation_runs_triggered_by_same_org_fk",
      columns: [t.triggeredBy, t.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete("set null"),
    index("impact_calculation_runs_org_event_created_idx").on(t.organizationId, t.eventId, t.createdAt.desc()),
    check("impact_calculation_runs_requested_is_a_level", sql`${t.requestedLevel} <> 'insufficient_data'`),
    check("impact_calculation_runs_achieved_not_above_requested", sql`${levelRank(t.achievedLevel)} <= ${levelRank(t.requestedLevel)}`),
    check("impact_calculation_runs_status_matches_level", sql`(${t.status} = 'SUCCEEDED') = (${t.achievedLevel} = ${t.requestedLevel})`),
    check("impact_calculation_runs_gross_only_when_reached",
      sql`(${t.grossDirectSpend} is not null) = (${levelRank(t.achievedLevel)} >= 2)`),
    check("impact_calculation_runs_attributable_only_when_reached",
      sql`(${t.attributableSpend} is not null) = (${levelRank(t.achievedLevel)} >= 3)`),
    // Employment is optional at level 3: a set without employment coefficients, or in another price year, has none.
    check("impact_calculation_runs_economic_only_when_reached",
      sql`case when ${t.achievedLevel} = 'economic_impact'
        then ${t.totalOutputImpact} is not null and ${t.totalValueAdded} is not null and ${t.totalIncome} is not null
        else ${t.totalOutputImpact} is null and ${t.totalValueAdded} is null and ${t.totalIncome} is null and ${t.totalEmploymentFte} is null end`),
    check("impact_calculation_runs_economic_needs_multiplier_set",
      sql`${t.achievedLevel} <> 'economic_impact' or ${t.multiplierSetId} is not null`),
    check("impact_calculation_runs_reached_needs_attendance",
      sql`${t.achievedLevel} = 'insufficient_data' or (${t.attendanceUsed} is not null and ${t.attendanceUsed} > 0 and ${t.attendanceBasis} in ('CHECKIN', 'REGISTRATION', 'ORGANIZER_ESTIMATE'))`),
    check("impact_calculation_runs_figures_non_negative",
      sql`coalesce(${t.grossDirectSpend}, 0) >= 0 and coalesce(${t.attributableSpend}, 0) >= 0 and coalesce(${t.totalOutputImpact}, 0) >= 0
        and coalesce(${t.totalValueAdded}, 0) >= 0 and coalesce(${t.totalIncome}, 0) >= 0 and coalesce(${t.totalEmploymentFte}, 0) >= 0`),
    check("impact_calculation_runs_sample_size_non_negative", sql`${t.sampleSize} >= 0`),
    check("impact_calculation_runs_snapshot_is_object", sql`jsonb_typeof(${t.inputSnapshot}) = 'object'`),
    check("impact_calculation_runs_sufficiency_is_array", sql`jsonb_typeof(${t.dataSufficiency}) = 'array'`),
    tenantReadPolicy("impact_calculation_runs", t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type ModuleRegistryEntry = typeof modulesRegistry.$inferSelect;
export type Attendee = typeof attendees.$inferSelect;
export type NewAttendee = typeof attendees.$inferInsert;
export type EventAnalyticsVector = typeof eventAnalyticsVectors.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type EventKpi = typeof eventKpis.$inferSelect;
export type SurveyQuestion = typeof surveyQuestions.$inferSelect;
export type Survey = typeof surveys.$inferSelect;
export type NewSurvey = typeof surveys.$inferInsert;
export type AiGeneration = typeof aiGenerations.$inferSelect;
export type NewAiGeneration = typeof aiGenerations.$inferInsert;
export type NewEventKpi = typeof eventKpis.$inferInsert;
export type NewSurveyQuestion = typeof surveyQuestions.$inferInsert;
export type SurveyResponse = typeof surveyResponses.$inferSelect;
export type MultiplierSet = typeof multiplierSets.$inferSelect;
export type ImpactCalculationRun = typeof impactCalculationRuns.$inferSelect;
export type OrganizationInvitation = typeof organizationInvitations.$inferSelect;
