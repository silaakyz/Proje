# Frontend API

All routes are Next.js Route Handlers under `/api`, same origin. The httpOnly session cookie `eip_session`
(or `Authorization: Bearer <session.accessToken>` for API clients) identifies the caller; identity is never
taken from the request body. Sessions live in PostgreSQL (`auth.sessions`) and end at sign-out or after 30 days.
Every organization-scoped call carries `organizationId` (query string for GET, JSON body otherwise) —
take it from `GET /api/me`.

Errors: `401` not signed in · `403` role not allowed (`{ error: "Insufficient role" }`) · `404` not found
or another organization's resource (indistinguishable) · `400` invalid input (`{ error: <zod tree> }`) ·
`409`/`422` with `{ error, code, ... }`.

| Permission | Roles |
|---|---|
| `org.read`, `task.update_status`, `checkin.perform`, `survey.collect` | owner, admin, staff |
| `blueprint.generate`, `proposal.decide`, `event.write`, `attendee.read`, `attendee.write`, `survey.manage`, `impact.manage` | owner, admin |

## Session

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/sign-up` | `{ email, password (8–72) }` → 201 `{ user, session: { accessToken, expiresAt }, needsEmailConfirmation: false }`, sets the cookie. 409 `EMAIL_IN_USE`. |
| POST | `/api/auth/sign-in` | same body → 200, same response. 401 `INVALID_CREDENTIALS`, 429 `RATE_LIMITED` (10 attempts per minute per address and client). |
| POST | `/api/auth/sign-out` | 204; deletes the session and the cookie. |
| POST | `/api/account/password` | `{ currentPassword, newPassword }` → `{ endedSessions }`; ends the account's other sessions. 403 `WRONG_PASSWORD`. |
| GET / DELETE | `/api/account/sessions` | number of active sessions / sign out everywhere else. |
| GET | `/api/me` | `{ user, membership: { organization, role, permissions } \| null }`. `null` → show onboarding. |
| POST | `/api/onboarding` | `{ organizationName, organizerType? }` → 201, caller becomes owner. 409 `ALREADY_MEMBER`; 403 `ORG_CREATION_CLOSED` when `SIGNUP_MODE=invite`. |
| GET | `/api/auth/options` | `{ signUp: "open" \| "invite", passwordReset: boolean }` — what the sign-in page offers. |
| POST | `/api/auth/password-reset` | `{ email }` → 202 always (unknown addresses are not revealed); e-mails a one-time link `/sifre-yenile#<token>` valid 60 minutes. 503 `EMAIL_DISABLED` without e-mail settings; 429 `RATE_LIMITED`. |
| POST | `/api/auth/password-reset/confirm` | `{ token, password }` → 204; ends every session of the account. 400 `RESET_LINK_INVALID` (unknown, used or expired). |

`SIGNUP_MODE=invite` (production default): `sign-up` only for addresses with an open invitation (403
`SIGNUP_INVITE_ONLY`), no new organizations from the browser — the first owner is created with
`npm run admin:create`. Invitations are e-mailed when `BREVO_API_KEY` + `EMAIL_FROM` are set (response `emailed`).

## Events

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events?organizationId&status?` | org.read | `status`: draft · live · completed |
| POST | `/api/events` | event.write | `{ organizationId, title, startDate?, endDate? }` (YYYY-MM-DD) → 201 |
| GET | `/api/events/:eventId?organizationId` | org.read | profile (Blueprint), modules, counts (tasks by status, KPIs, surveys, pending proposals, attendees) |
| PATCH | `/api/events/:eventId` | event.write | `{ organizationId, title?, status?, startDate?, endDate? }`; 422 `INVALID_EVENT` (e.g. live without start date). Changing `startDate` moves the due dates of tasks that still follow the AI schedule (start + offset); due dates a person set and DONE tasks stay |

## AI event creation

1. `POST /api/ai/blueprint { organizationId, prompt, modules? }` — streams a preview (`useObject`);
   header `x-generation-id`.
2. Poll `GET /api/ai/generations/:generationId?organizationId` until `done: true`
   (`status`: SUCCEEDED · FAILED_VALIDATION · FAILED_PROVIDER). `proposals[]` lists the card it produced.
3. Cards: `GET /api/proposals?organizationId&eventId?&status?` — `eventId=none` for blueprint.core cards;
   `status` comma list of PENDING, APPLIED, REJECTED, FAILED, EXPIRED. Each card has `operations[]`.
4. Decide: `POST /api/proposals/:proposalId { action: "apply", organizationId, opIndexes? }` →
   `{ status: "APPLIED", eventId, ... }` (creates the event for blueprint.core) or `{ action: "reject" }`.
5. Sections: `POST /api/ai/blueprint/sections { organizationId, eventId, sections? }` → 202; the cards
   (tasks, KPIs, surveys) appear under `GET /api/proposals?eventId=…&status=PENDING`.

`POST /api/ai/event-builder` (single-shot config) is unchanged.

Workspace assistant (read-only, org.read): `POST /api/ai/assistant { organizationId, eventId?, mode: "chat" | "report",
messages: [{ role, content }] }` streams plain Turkish text grounded in the caller's recorded data (counts only, no
personal data). It never writes. Every AI route answers 503 `AI_NOT_CONFIGURED` when the selected provider's key (`GOOGLE_GENERATIVE_AI_API_KEY` or `ANTHROPIC_API_KEY`) is unset.

## Planning

| Method | Path | Permission |
|---|---|---|
| GET | `/api/events/:eventId/tasks?organizationId` | org.read |
| PATCH | `/api/tasks/:taskId` `{ organizationId, status: TODO \| IN_PROGRESS \| DONE }` | task.update_status |
| GET | `/api/events/:eventId/kpis?organizationId` | org.read |
| PATCH | `/api/kpis/:kpiId` `{ organizationId, status?: ACTIVE \| DROPPED, targetValue?: number \| null }` | event.write |

A task moved to DONE gets `completedAt` automatically (cleared when it leaves DONE). An ACTIVE or DROPPED
KPI is never rewritten by a regenerated AI plan. `GET /api/proposals` marks PENDING cards past `expiresAt`
as EXPIRED before listing them.

## Attendees, QR and check-in

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/events/:eventId/attendees` | attendee.write | `{ organizationId, ticketType, quantity? (1–500) }` → 201 with each `qrToken` |
| GET | `/api/events/:eventId/attendees?organizationId` | attendee.read | no QR tokens in the list |
| GET | `/api/events/:eventId/attendees/:attendeeId/qr?organizationId` | attendee.write | `{ attendeeId, ticketType, qrToken, cancelledAt }` — render `qrToken` as the QR content |
| POST | `/api/events/:eventId/attendees/cancel` | attendee.write | `{ organizationId, attendeeIds[] }` → `{ cancelled, alreadyCancelled, checkedIn, notFound }`; voided tickets leave every count |
| GET | `/api/events/:eventId/tickets?organizationId&attendeeId*&format?` | attendee.write | printable tickets `{ attendeeId, ticketType, qrToken, isCheckedIn, qrSvg }`; `format=svg` + one `attendeeId` → the QR image (`image/svg+xml`) |
| POST | `/api/events/:eventId/checkin/undo` | attendee.write | `{ organizationId, attendeeId }` → `CHECK_IN_REVERSED` · 409 `NOT_CHECKED_IN` |
| POST | `/api/events/:eventId/checkin` | checkin.perform | `{ organizationId, qrToken }` (the QR content, or the printed ticket number `EIP-` + first 8 hex of the attendee id; 409 `AMBIGUOUS_TICKET_CODE` if two match) → 200 `CHECKED_IN` · 404 `UNKNOWN_TICKET` · 409 `ALREADY_CHECKED_IN` (with `checkedInAt`) · 409 `TICKET_CANCELLED` · 409 `EVENT_COMPLETED` |
| GET | `/api/events/:eventId/checkins?organizationId` | checkin.perform | totals, per ticket type, 20 latest |
| GET | `/api/events/:eventId/checkins/stream?organizationId` | checkin.perform | Server-Sent Events, see below |

Live counter:

```js
const es = new EventSource(`/api/events/${eventId}/checkins/stream?organizationId=${orgId}`);
es.addEventListener("summary", (e) => setSummary(JSON.parse(e.data)));   // first message + every count change
es.addEventListener("checkin", (e) => addToFeed(JSON.parse(e.data)));   // { attendeeId, ticketType, checkedInAt }
```

The stream closes after ~270 s and EventSource reconnects automatically; the first `summary` after a
reconnect re-synchronises the counts. Polling `GET …/checkins` works as a fallback.

## Surveys and responses

Surveys are created by the AI (`blueprint.surveys` cards). Responses are anonymous: no name, contact or
ticket is stored with them.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/surveys/:surveyId?organizationId` | org.read | the survey with its questions (`acceptingResponses`, response count); `publicToken` only for survey.manage — staff use it to type in responses |
| GET | `/api/events/:eventId/surveys?organizationId` | org.read | status, version, question and (non-excluded) response counts; `publicToken` only for survey.manage |
| POST | `/api/surveys/:surveyId` | survey.manage | `{ organizationId, action: "open" \| "close" }`; open: DRAFT → OPEN and creates `publicToken`. 409 `INVALID_TRANSITION`, 422 `NO_QUESTIONS` |
| GET | `/api/surveys/:surveyId/responses?organizationId` | survey.manage | answers, normalised profile, `spendKurus`, exclusion |
| POST | `/api/surveys/:surveyId/responses` | survey.collect | staff types in a response: `{ organizationId, answers, sensitiveConsent? }` → 201 |
| PATCH | `/api/survey-responses/:responseId` | survey.manage | `{ organizationId, isExcluded, reason? }` (reason required to exclude) |
| GET | `/api/public/surveys/:token` | — (public) | the survey's questions (`key`, `type`, `text`, `required`, `options`, `showIf`, `isSensitive`, `helpText`) |
| POST | `/api/public/surveys/:token/responses` | — (public) | `{ answers, sensitiveConsent? }` → 201 `{ submittedAt }` |

Public link: `/anket/<publicToken>` in the frontend calls the two public routes. 404 unknown link ·
409 `SURVEY_NOT_OPEN` · 422 `INVALID_ANSWERS` with `problems: string[]`.

`answers` is keyed by question `key`. Types: `LIKERT_5` 1–5 · `NPS_0_10` 0–10 · `YES_NO` boolean ·
`SINGLE_CHOICE` option value · `MULTI_CHOICE` list of option values · `NUMBER` (`q_party_size` 1–500,
`q_days_present` 1–366, `q_nights_stayed` 0–366, others 0–1,000,000) · `PERCENT` −100…10,000 ·
`CURRENCY_TRY` TL with ≤ 2 decimals · `PROVINCE` plate code 1–81, 0 = abroad · `OPEN_TEXT` 1–2,000 chars.
Leave unanswered questions out (or `null`). A question whose `showIf` does not match must not be answered;
a visible `required` one must be. Answering an `isSensitive` question needs `sensitiveConsent: true`
(show the explicit consent text next to it; it is never pre-ticked).

## One survey link (one QR code) per event (0015, 0016)

Like section branching in a form builder: one public link per event for all of its measurement forms. Question 1 asks
the respondent's role; each answer option ("route") opens one or more audiences' surveys — by default "Ziyaretçi" opens
the visitor and the local-residents survey. A question shared by those surveys (same key) is asked once; every survey
stores its own response with the answers to its own questions, all in one transaction (all or nothing), so the impact
engine and KPIs read them unchanged. The organizer can edit question 1 and its options. The link exists from the first
visit of the Anketler page (the QR code can be printed early); options whose surveys are not open are not shown to
respondents. Per-survey links (`/anket/:token`) keep working.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events/:eventId/survey-link?organizationId` | survey.manage | `{ link: { token, roleQuestion, customized, routes: [{ key, label, audiences }], surveys: [{ audience, surveyId, title, version, status, accepting, questions }] } }`; page: `/anket/etkinlik/:token` |
| PUT | `/api/events/:eventId/survey-link` | survey.manage | `{ organizationId, roleQuestion: string \| null, routes: [{ key, label, audiences }] \| null }` (null = defaults); 422 `SURVEY_LINK_INVALID` when an option opens an audience without a survey |
| POST | `/api/events/:eventId/survey-link` | survey.manage | `{ organizationId, action: "open_all" }` → `{ opened, skipped: [{ audience, reason }], link }`: opens the latest DRAFT of every audience with no open survey |
| GET | `/api/public/event-surveys/:token` | public | `{ survey: { eventTitle, roleQuestion: { text, helpText, options: [{ value, label }] }, routes: [{ key, audiences }], sections: [{ audience, title, intro, version, questions }] } }`; 404 unknown link, 409 `SURVEY_NOT_OPEN` |
| POST | `/api/public/event-surveys/:token/responses` | public | `{ role: route key, answers, sensitiveConsent? }` → 201; one response per opened survey; 409 `SURVEY_NOT_OPEN`, 422 `INVALID_ANSWERS` (nothing stored); same rate limit as the per-survey link |

## Public registration form — KVKK (0018)

One form per event, created disabled with a privacy-notice (aydınlatma metni) template filled with the organization and
event names. Every registration stores the notice version and its SHA-256 hash (proof of what the person read) and the
optional marketing consent (unticked by default) with its exact text and time. A registration creates an attendee with a
QR ticket; the ticket link is e-mailed when e-mail is configured. Personal data is erased automatically `retentionDays`
after the event ends (scheduler tick) or on request (organizer); the ticket row stays, without the name.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events/:eventId/registration-form?organizationId` | attendee.write | `{ form: { token, enabled, ticketType, capacity, opensAt, closesAt, collectPhone, privacyNotice, noticeVersion, marketingConsentText, retentionDays, registered, state } }`; page: `/kayit/:token` |
| PUT | `/api/events/:eventId/registration-form` | attendee.write | same fields + `organizationId`; changing the notice text raises `noticeVersion` |
| GET | `/api/events/:eventId/registrations?organizationId` | attendee.read | `{ registrations: [{ id, fullName, email, phone, ticketType, isCheckedIn, noticeVersion, marketingConsent, createdAt }] }` |
| DELETE | `/api/registrations/:registrationId?organizationId` | attendee.write | 204; erases the personal data (KVKK m. 7 / m. 11 request) |
| GET | `/api/public/registrations/:token` | public | `{ form: { eventTitle, organization, city, startDate, endDate, collectPhone, privacyNotice, noticeVersion, marketingConsentText, state } }`; 404 when disabled or unknown |
| POST | `/api/public/registrations/:token` | public | `{ fullName, email, phone?, noticeVersion, noticeAccepted: true, marketingConsent? }` → 201 `{ ticket: { qrToken, ticketType, emailed } }`; 409 `REGISTRATION_NOT_OPEN` / `REGISTRATION_CLOSED` / `REGISTRATION_FULL` / `ALREADY_REGISTERED` / `NOTICE_CHANGED`; rate limited |
| GET | `/api/public/tickets/:qrToken` | public | `{ ticket: { eventTitle, startDate, endDate, fullName, ticketType, isCheckedIn, cancelled } }`; page: `/bilet/:qrToken` |

## Event report (PDF)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/events/:eventId/report` | org.read | `{ organizationId, summary? }` → `application/pdf` (attachment): attendance, tasks, KPIs (engine / manual / no data), surveys, budget totals (budget.read only), latest stored impact run with its checks; `summary` (the assistant's draft) is appended as a labelled annex. Nothing is estimated in the report. |

## Impact

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events/:eventId/impact?organizationId&level?` | org.read | readiness: attendance basis, response counts, recorded inputs, every check, `achievedLevel`, `latestRun`; `figures: null` |
| GET | `/api/events/:eventId/impact/inputs?organizationId` | org.read | `inputs` or `null` |
| PUT | `/api/events/:eventId/impact/inputs` | impact.manage | `{ organizationId, priceYear, attributionMethod? (SURVEY_STRICT default · RECORDED_DEADWEIGHT), deadweight?, displacement?, leakage?, multiplierSetId? }`; each adjustment `{ value: 0–1, source: ≥ 10 chars }` or `null`; RECORDED_DEADWEIGHT requires `deadweight` (400). Runs carry `breakdown.attribution` (method, strict shares per category, broad-rule sensitivity) |
| GET | `/api/multiplier-sets?organizationId` | org.read | the organization's sets with coefficients |
| POST | `/api/multiplier-sets` | impact.manage | `{ organizationId, name, source, ioBaseYear, priceYear, nuts2Code (null = national), method (NATIONAL · SLQ · CILQ · FLQ · SURVEY_BASED), multiplierType (TYPE_I · TYPE_II), coefficients: [{ spendCategory, a64Code?, output, valueAdded, income, employmentPerMTry (null = none) }] }` → 201; no employment figure is reported unless every spent category has one |
| POST | `/api/io/tuik-2023` | org.read | preview: `{ organizationId, region: null \| { nuts2Code, delta (0 ≤ δ < 1), deltaSource, regional: {A, B-E, F, G-I, J, K, L, M-N, O-Q, R-U}, national: {…same keys}, dataSource } }` → `{ engineVersion, mappingVersion, source, files, year, multiplierType: TYPE_I, method: NATIONAL \| FLQ, region: { lambda, regionalShare, slqA10 } \| null, categories: [{ spendCategory, mapping, a64Code, output, valueAdded, income, employmentPerMTry: null, bridge: { basic, margins, taxes, imports, domesticDemand } }] }`; 422 `IO_INVALID` (e.g. regional total above national) |
| POST | `/api/multiplier-sets/from-io` | impact.manage | same body + `name` → 201 `{ multiplierSet }` (source text composed automatically, ioBaseYear = priceYear = 2023, employment null) |
| PATCH | `/api/multiplier-sets/:setId` | impact.manage | `{ organizationId, isActive }`; coefficients are never edited — record a new set |
| GET | `/api/events/:eventId/impact/runs?organizationId` | org.read | stored runs, newest first |
| GET | `/api/impact-runs/:runId?organizationId` | org.read | one stored run (what a report cites) |
| POST | `/api/events/:eventId/impact/runs` | impact.manage | `{ organizationId, level? }` (default ECONOMIC_IMPACT) → 201 `run` |

`level`: SPEND · ATTRIBUTABLE_SPEND · ECONOMIC_IMPACT. A run always stores its `checks` and
`inputSnapshot`; `achievedLevel` is the highest level the data supported (`null` = none) and `status` is
SUCCEEDED only when it equals the requested level. `figures` holds only reached levels (TRY, price year
of the inputs): `grossDirectSpend` (level 1), `attributableSpend` (2), `totalOutputImpact`,
`totalValueAdded`, `totalIncome`, `totalEmploymentFte` (3; employment null when the set has no employment coefficients or another price year); `breakdown` has visitor share, mean days, mean
spend per visitor-day and per-category values. Runs never change; cite a run `id` in a report.
Spend categories: ACCOMMODATION · FOOD_BEVERAGE · LOCAL_TRANSPORT · INTERCITY_TRANSPORT · RETAIL_SHOPPING ·
ENTERTAINMENT_CULTURE · VENUE_AND_SERVICES · MARKETING_PRINTING · OTHER.

## Team and organization (0009)

| Method | Path | Permission | Notes |
|---|---|---|---|
| PATCH | `/api/org` | org.manage | `{ organizationId, name?, organizerType? }` |
| GET | `/api/org/members?organizationId` | org.read | `{ members: [{ userId, email, role, joinedAt, lastSignInAt, isSelf }] }` |
| PATCH | `/api/org/members/:userId` | member.manage | `{ organizationId, role }`; owners only; 409 `LAST_OWNER` |
| DELETE | `/api/org/members/:userId?organizationId` | org.read | remove (owner: anyone, admin: staff) or leave (self); 409 `LAST_OWNER` |
| GET | `/api/org/invitations?organizationId` | member.manage | open invitations |
| POST | `/api/org/invitations` | member.manage | `{ organizationId, email, role: admin \| staff }` → 201 `{ invitation, token }`; link `/davet/<token>`, valid 7 days; admins invite staff only |
| DELETE | `/api/org/invitations/:id?organizationId` | member.manage | revoke |
| GET | `/api/invitations/:token` | public | `{ invitation: { organizationName, email, role, state } }` |
| POST | `/api/invitations/:token` | session | join: same e-mail, account without organization. 403 `INVITATION_EMAIL_MISMATCH`, 410 `INVITATION_*` |

## Event lifecycle (0009)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events?organizationId&archived=1` | org.read | archived events only (the default list hides them) |
| POST | `/api/events/:eventId/archive` | event.write | `{ organizationId, archived }` |
| POST | `/api/events/:eventId/duplicate` | event.write | `{ organizationId, title?, startDate?, endDate? }` → new draft with profile, modules, tasks, KPIs, survey drafts |
| GET | `/api/events/:eventId/attendees/export?organizationId` | attendee.read | CSV (UTF-8 BOM, `;`), no QR tokens |

AI provider: `AI_PROVIDER=google` (Gemini, free tier; `GOOGLE_GENERATIVE_AI_API_KEY`) or `anthropic` (`ANTHROPIC_API_KEY`).
`GET /api/ai/generations/:id` adds `quotaExceeded: true` when the provider refused for quota/rate limit.

## KPI values (kpi-engine/1.1.0)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events/:eventId/metrics?organizationId` | org.read | every computable metric of the KPI reference: `{ engineVersion, catalogVersion, computedAt, values: [{ id, value \| null, reason?, n?, interval?, note? }] }` |
| GET | `/api/events/:eventId/kpis?organizationId` | org.read | now also `actuals: [{ id, metricName, catalogId, computed, actual, actualSource: engine \| manual \| null }]` |
| PATCH | `/api/kpis/:kpiId` | event.write | `actualValue` (manual) only for metrics the engine does not compute; else 422 `KPI_COMPUTED` |

Catalog, formulas, evidence codes (K/S/T) and sources: `src/lib/kpi/catalog.ts`; UI: `/metrikler`.
Finance metrics (§3.4 and the organizer local spend of §3.10) are computed only for callers with `budget.read`; for staff
they are `value: null, reason: no_data` with a note.

## Budget (0012)

Owner and admin only (`budget.read`, `budget.manage`); staff sees neither lines nor finance metrics. Amounts are TRY with at
most 2 decimals in the API, integer kuruş in the database. Finance metrics use **actual** amounts only.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events/:eventId/budget?organizationId` | budget.read | `{ items: [...], totals: { income, cost, ticketAdjustments: { planned, actual, lines }, net: { planned, actual } } }` |
| POST | `/api/events/:eventId/budget` | budget.manage | `{ organizationId, kind: INCOME \| COST \| TICKET_ADJUSTMENT, category, label, planned?, actual?, quantity? (ticket income only: paid tickets), costBehavior? FIXED \| VARIABLE, supplierLocal?, fundedExternally? (cost only), notes? }` → 201 `{ item }`; a planned or an actual amount is required |
| PATCH | `/api/budget-items/:itemId` | budget.manage | any field; the merged line is validated again (a kind change drops fields that no longer apply) |
| DELETE | `/api/budget-items/:itemId?organizationId` | budget.manage | 204 |
| GET | `/api/events/:eventId/budget/export?organizationId` | budget.read | CSV (UTF-8 BOM, `;`, decimal comma) |

Categories: `src/lib/budget/categories.ts`. Ticket income is entered **net** of refunds and discounts; refunds and discounts
are TICKET_ADJUSTMENT lines (neither income nor cost), so gross ticket revenue = net + refunds + discounts.

## External data sources (0013)

Per event; credentials of the services stay in the server environment (`.env`), never in the database or the API.
Pulls run on demand and automatically while the app runs, each source at its own interval (`syncIntervalMinutes`; provider
default and limits in `PROVIDER_INFO.sync`, 0 = automatic pulls off; `CONNECTORS_SYNC_INTERVAL_MINUTES=0` turns them all off) for events
from 60 days before their start to 30 days after their end; `npm run connectors:pull` does one pass for external
schedulers. Setup of each service: `docs/veri-kaynaklari.md`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events/:eventId/data-sources?organizationId` | org.read | `{ event, window: { from, to } \| null, providers: [{ provider, label, feeds, terms, docs, envKeys, missingEnv, sync: { defaultMinutes, minMinutes, maxMinutes, note, choices }, source: null \| { id, config, enabled, lastSyncAt, lastStatus: OK \| ERROR, lastError, lastSummary, observations, syncIntervalMinutes, syncIsDefault, nextSyncAt } }] }` |
| PUT | `/api/events/:eventId/data-sources` | data.manage | `{ organizationId, provider: OPEN_METEO_AIR \| BREVO \| GA4 \| META \| YOUTUBE \| NEWS, config, enabled?, syncIntervalMinutes? }`; config per `PROVIDER_CONFIG` (src/lib/connectors/providers.ts); a changed config deletes the old observations (compared regardless of key order); `syncIntervalMinutes`: null = default, 0 = off, otherwise one of the provider's `sync.choices` (422 `SYNC_INTERVAL_INVALID`); omitted = unchanged |
| POST | `/api/events/:eventId/data-sources/pull` | data.manage | `{ organizationId, provider? }` → `{ results: [{ provider, status, summary? \| error? }] }`; a provider failure is recorded on the source, never a 5xx |
| DELETE | `/api/data-sources/:sourceId?organizationId` | data.manage | 204; its observations go with it |
| GET | `/api/events/:eventId/mentions?organizationId` | org.read | press candidates and reviewed clippings |
| POST | `/api/events/:eventId/mentions` | data.manage | `{ organizationId, url, title?, publishedAt? }` → 201 (stored VERIFIED); 409 `MENTION_EXISTS` |
| PATCH | `/api/mentions/:mentionId` | data.manage | `{ organizationId, status: CANDIDATE \| VERIFIED \| REJECTED }`; only VERIFIED count in `media_coverage_count` |
| GET | `/api/events/:eventId/uploads?organizationId` | data.manage | row counts of the sponsor / lead lists |
| POST | `/api/events/:eventId/uploads/sponsors\|leads` | data.manage | `{ organizationId, csv }` → `{ stored, issues, droppedColumns, unknownColumns }`; replaces the list; 422 `CSV_INVALID` stores nothing. Name / e-mail / phone / id columns are dropped |
| DELETE | `/api/events/:eventId/uploads/sponsors\|leads?organizationId` | data.manage | 204 |

Metrics fed (kpi-engine/1.2.0): e-mail rates (Brevo), landing-page conversion and traffic uplift (GA4), social reach,
engagement and Instagram hashtag mentions (Meta), YouTube views and engagement, verified press clippings, air quality
during the event hours (Open-Meteo / EEA index; platform additions), sponsor ROI / CPM / renewal and the lead metrics
(CSV). Money-based ones need `budget.read`. For these external metrics a KPI's manual actual is accepted while the
engine has no value; once a source delivers one, the engine value is shown.

## Own data tables (0014)

Organizations upload their own Excel (.xlsx) or CSV tables per event; they are read on the server (no library, no
macros or formulas evaluated), turned into typed columns, and — after a person confirms what each column means — feed
catalog metrics, the Analizler page, the assistant and the report. Details: `docs/kendi-verileri.md`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/events/:eventId/datasets?organizationId` | org.read | `{ aiAvailable, datasets: [{ id, name, fileName, sheetName, status: NEEDS_REVIEW \| CONFIRMED, rowCount, columns, mapping, droppedColumns, summary, interpretation: null \| { text, model, at, stale } }] }` (no rows) |
| POST | `/api/events/:eventId/datasets` | data.manage | `{ organizationId, fileName, content (base64, ≤ 6 MB), sheet?, name? }` → 201 `{ id, sheets, sheet, rows, columns, droppedColumns, notes }`; 422 `DATASET_XLS` \| `DATASET_TYPE` \| `DATASET_UNREADABLE` \| `DATASET_NO_TABLE` \| `DATASET_SHEET`, 413 `DATASET_TOO_LARGE` |
| GET | `/api/datasets/:datasetId?organizationId` | data.manage | `{ id, name, status, columns, mapping, rows (first 15) }` for the mapping review |
| PATCH | `/api/datasets/:datasetId` | data.manage | `{ organizationId, name?, mapping: [{ key, role }] }` → CONFIRMED; role = `date` \| `group` \| `value` \| `ignore` \| `measure:<key>` (`src/lib/datasets/measures.ts`); 422 `DATASET_MAPPING` with the problems |
| DELETE | `/api/datasets/:datasetId?organizationId` | data.manage | 204 |
| POST | `/api/datasets/:datasetId/interpret` | data.manage | `{ organizationId }` → `{ text, model, at }`; 409 `DATASET_NOT_CONFIRMED`, 429 `AI_QUOTA`, 502 `AI_PROVIDER_ERROR` |

Metrics fed (kpi-engine/1.3.0): `DATASET_KPI_IDS` in `src/lib/kpi/datasets.ts` — waste, recycling and carbon per
attendee, incident / complaint rates, check-in waits, session attendance, fill, satisfaction and schedule adherence,
B2B meetings, engagement, virtual viewing, vendor sales change, registration funnel, staffing, badges and vendor
punctuality. Only confirmed tables count; a KPI's manual actual is accepted while no table delivers a value.
