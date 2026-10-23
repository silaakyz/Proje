# Prisma → Drizzle: removal record

Prisma is removed. Drizzle (`src/db`, `drizzle/`) is the only database layer. The last Prisma design
(`prisma/schema.prisma`, its migrations and the legacy services) is in git history before the removal
commit — tag that commit (e.g. `prisma-design-final`) before removing, if you want a named reference.

## What was removed

- `prisma/` (schema, migrations, seed, shadow-DB SQL), `prisma.config.ts`, `src/generated/` (client)
- legacy services: `src/server/db.ts`, `src/server/planning/apply-proposal.ts`, `src/server/ai/blueprint.ts`,
  `src/server/logistics/ai-generations.ts`, `src/server/auth/require-org-role.ts`
- `tests/integration/` and `vitest.integration.config.ts`; `scripts/dev-db/` (Prisma schema-engine harness)
- packages `prisma`, `@prisma/client`, `@prisma/adapter-pg`, `@prisma/driver-adapter-utils`,
  `@prisma/schema-engine-wasm`, `pglite-prisma-adapter`; scripts `postinstall`, `db:*`, `test:integration`;
  `verify` = typecheck + test + drizzle:check + test:db

`src/server/__tests__/no-prisma-in-routes.test.ts` keeps it that way: no route reaches Prisma, no source,
test or script imports a Prisma package or generated client, `package.json` has no Prisma dependency or
script, and the removed paths stay absent. (`package-lock.json` still lists `prisma` / `@prisma/client` as
*optional peers of drizzle-orm*; npm does not install them.)

## Models

| Prisma model | Drizzle | Status |
|---|---|---|
| Organization, Profile, OrganizationMember | `organizations`, `users` (one organization per user, role owner/admin/staff) | ported (simplified) |
| Event | `events` (+ `ai_config`, `modules_registry`) | ported |
| AiGeneration, AiActionProposal | `ai_generations`, `proposals` | ported |
| Task | `tasks` | ported; `BLOCKED`/`CANCELLED` not supported |
| EventKpi | `event_kpis` | ported |
| Survey | `surveys` (+ `public_token`, 0007), `survey_questions` | ported |
| SurveyResponse, SpendItem | `survey_responses`, `survey_response_spend` (0007) | ported, anonymous (no attendee link, no respondent ref) |
| MultiplierSet, Multiplier | `multiplier_sets`, `multipliers` (0007) | ported, organization-owned, one row per spend category |
| ImpactCalculationRun | `impact_calculation_runs` (0007) + `event_impact_inputs` | ported; immutable; level/figure CHECKs |
| MetricDefinition | `METRIC_LIBRARY` in code | in code (evidence `UNREVIEWED`; the old "REVIEWED needs a citation" DB rule has no counterpart because nothing can be marked reviewed) |
| Attendee, CheckIn | `attendees` (ticket-type label, QR, check-in state) | ported **without personal data**; one check-in per ticket, no scan log |
| SpendCategoryMap | — | not in MVP: no A-64 sector split / retail margin (decision 5) |
| ImpactReport, SentimentResult, EventBenchmark | — | not in MVP (no report narratives, NLP or benchmarks) |
| TicketType, FormField, EventDay | — | not in MVP: pricing, registration forms with personal data (and their KVKK consent records), multi-day admission |
| BudgetLine, Risk, Stakeholder | — | not in MVP; AI `budget_risks` / `registration` sections answer `unsupported` |

## Integration tests → Drizzle coverage

| Removed Prisma suite | Drizzle coverage (`tests/db`, PGlite) |
|---|---|
| `apply-proposal.int` | `apply-proposal.test.ts` (exactly-once, rollback/retry, regeneration preserves edits, activated KPI / opened survey, cross-tenant, tampered, expired, selection, assignee from another org). The ANALYST role does not exist in Drizzle. |
| `llm-pipeline.int` | `blueprint-pipeline.test.ts` |
| `tenant-isolation.int` | `tenant-isolation.test.ts`, `access-hardening.test.ts`, `planning.test.ts`, `security-surface.test.ts`, `surveys-impact.test.ts` |
| `migrations.int` | `security-surface.test.ts` (RLS on every table, grants, pinned `search_path`), `tenant-isolation.test.ts` (HNSW); auth sync = `users.id → auth.users ON DELETE CASCADE` + onboarding |
| `impact-guarantees.int` | `surveys-impact.test.ts` (no figure above the achieved level, run immutability, set used by a run cannot be deleted) and `src/lib/impact/__tests__/engine.test.ts` |

## Before any deploy

Read-only check of the target database: does it contain `_prisma_migrations` or Prisma-era tables
(`organization_members`, `ai_action_proposals`, schema `analytics`)? Drizzle's migrations assume a
database created by `drizzle/` 0000 onwards. (Written when the target was hosted Supabase; the project now runs on plain PostgreSQL, see docs/local-setup.md.)
