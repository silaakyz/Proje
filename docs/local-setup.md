# Local setup (PostgreSQL only)

Next.js Route Handlers + Drizzle on a plain PostgreSQL 15+ server with pgvector. Sign-in, sessions and rate
limits live in the same database; no other service is needed (the AI routes additionally need
an AI key: `GOOGLE_GENERATIVE_AI_API_KEY` for Gemini (free tier) or `ANTHROPIC_API_KEY`).

## 1. PostgreSQL

Easiest: Docker (Docker Desktop on Windows/macOS). `docker-compose.yml` starts `pgvector/pgvector:pg16`
on `127.0.0.1:5432` with user and database `eip`:

```bash
# .env: POSTGRES_PASSWORD=<choose one>, DATABASE_URL=postgresql://eip:<same password>@localhost:5432/eip
docker compose up -d db          # or: npm run db:up
```

Without Docker: install PostgreSQL 15+ and the pgvector package for it, create a database and a login role
that owns it. The role that runs the migrations must be allowed to create roles and the `vector` extension
(a superuser), or a superuser prepares them once — `npm run db:preflight` says which is missing:

```sql
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant anon, authenticated, service_role to <app role>;
-- connected to the app database:
create schema extensions authorization <app role>; create extension vector with schema extensions;
```

## 2. Environment

`.env` in the project root (git-ignored; never commit it). See `.env.example`.

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://eip:<password>@localhost:5432/eip` (percent-encode `@`, `#`, `ı` … in the password) |
| `DIRECT_URL` | optional; migrations/preflight connection if it must differ from `DATABASE_URL` |
| `AI_PROVIDER`, `GOOGLE_GENERATIVE_AI_API_KEY` | AI routes (`/api/ai/*`) with Gemini (free tier, https://aistudio.google.com); or `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` |
| `SIGNUP_MODE` | `open` (default: anyone may sign up and create an organization) or `invite` (production) |
| `BREVO_API_KEY`, `EMAIL_FROM`, `APP_URL` | optional e-mail: invitations, password reset, registration tickets |

## 3. Database

```bash
npm install
npm run db:preflight     # READ-ONLY: prerequisites, existing tables, migration state, 0006 stop conditions
npm run drizzle:migrate  # scripts/db/bootstrap.sql (idempotent), then every pending drizzle/ migration in ONE transaction
npm run admin:create -- you@example.com "Kurum adı" MUNICIPALITY   # first owner (asks for the password)
```

`bootstrap.sql` creates what a managed platform used to provide: pgvector in schema `extensions`, the roles
`anon` / `authenticated` / `service_role` (the RLS policies target `authenticated`), `auth.users`,
`auth.sessions`, `auth.uid()` and `app_private.rate_limits`. It is safe to re-run.

## 4. Run and try the API

```bash
npm run dev
curl -s -c jar -X POST localhost:3000/api/auth/sign-up -H 'content-type: application/json' -d '{"email":"a@example.com","password":"…"}'
curl -s -c jar -X POST localhost:3000/api/auth/sign-in -H 'content-type: application/json' -d '{"email":"a@example.com","password":"…"}'
curl -s -b jar localhost:3000/api/me                                  # membership: null → onboard
curl -s -b jar -X POST localhost:3000/api/onboarding -H 'content-type: application/json' -d '{"organizationName":"Örnek Belediyesi","organizerType":"MUNICIPALITY"}'
```

Instead of the cookie jar, send `Authorization: Bearer <session.accessToken>` from the sign-in response.
All routes: docs/frontend-api.md.

## 5. Accounts

There is no e-mail confirmation or password reset e-mail in the MVP. To set a new password for an account
(this also ends its sessions): `npm run auth:set-password -- someone@example.com` (asks for the password).

## Production

One server with Docker (PostgreSQL + app + HTTPS + daily backups): `docs/canliya-alma.md`.
