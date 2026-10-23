/**
 * Demo data for presentations: the "OZBDA" organization with four events in different states, created
 * through the application's own services (proposal → apply, ticket issue, survey open, response submit,
 * impact run), so every row passes the same validation and constraints as data entered in the UI.
 *
 *   npm run demo:seed                 (reads .env: DATABASE_URL, DEMO_EMAIL, DEMO_PASSWORD, …)
 *
 * WRITES TO THE DATABASE IN DATABASE_URL. Run it only against the database you mean to fill.
 * Idempotent: if the demo organization already has its events, it only adds what later versions brought (the stand
 * owner, local business and sponsor surveys behind the single survey link) and changes nothing else.
 *
 * Content: event profiles, plans, survey answers and budget lines are sample data written for the demo (no model call).
 * No multiplier coefficients or impact adjustments (deadweight, displacement, leakage) are invented:
 * those stay empty for the organizer to enter with a source, so the stored run reaches the spend level only.
 *
 * The sign-in account: if DEMO_EMAIL has no account yet, the script creates it in auth.users with DEMO_PASSWORD
 * (the same scrypt hash the sign-up form stores). An existing account and its password are left unchanged.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

const DEMO_EMAIL = process.env.DEMO_EMAIL?.trim().toLowerCase();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const ORG_NAME = process.env.DEMO_ORG_NAME?.trim() || "OZBDA";
const ORG_TYPE = (process.env.DEMO_ORG_TYPE?.trim() || "EVENT_AGENCY") as "EVENT_AGENCY";

function fail(message: string): never {
  console.error(`demo:seed — ${message}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (.env).");
if (!DEMO_EMAIL) fail("DEMO_EMAIL is not set (.env).");

const { sql, eq, and, inArray } = await import("drizzle-orm");
const { adminDb } = await import("@/db");
const schema = await import("@/db/schema");
const { normalizeBlueprintCore, BLUEPRINT_SCHEMA_VERSION } = await import("@/lib/ai/blueprint/core");
const { coreProposal, tasksProposal, kpisProposal, surveysProposal } = await import("@/lib/ai/blueprint/operations");
const { normalizeTasks } = await import("@/lib/ai/blueprint/sections/tasks");
const { normalizeKpis, deriveDataRequirements, deriveMeasurementTasks } = await import("@/lib/ai/blueprint/sections/kpis");
const { normalizeSurveys, surveyAudiencesFor } = await import("@/lib/ai/blueprint/sections/surveys");
const { candidateMetrics } = await import("@/lib/metrics/library");
const { vocabularyFor } = await import("@/lib/modules/registry");
const { saveProposal, loadApprovedCore } = await import("@/server/ai/blueprint-drizzle");
const { applyProposal } = await import("@/server/planning/apply-proposal-drizzle");
const { startGeneration, finishGeneration } = await import("@/server/logistics/ai-generations-drizzle");
const { registerAttendees } = await import("@/server/logistics/checkin");
const { setSurveyStatus, getSurveyDetail, submitPublicResponse } = await import("@/server/surveys/survey-service");
const { putImpactInputs, runImpactCalculation } = await import("@/server/analytics/impact-service");
const { reflowTaskDueDates } = await import("@/server/events/events-service");
const { createBudgetItem } = await import("@/server/finance/budget-service");
const { todayIstanbul } = await import("@/lib/time/istanbul");

type OrgAccess = import("@/server/auth/org-access").OrgAccess;
type BlueprintCoreDraft = import("@/lib/ai/blueprint/core").BlueprintCoreDraft;
type BlueprintCore = import("@/lib/ai/blueprint/core").BlueprintCore;
type ModuleKey = import("@/lib/modules/registry").ModuleKey;

const today = todayIstanbul();
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Deterministic pseudo-random numbers: the same demo every run.
let seed = 20261017;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const weighted = <T,>(xs: readonly (readonly [T, number])[]) => {
  let r = rand() * xs.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of xs) if ((r -= w) <= 0) return v;
  return xs[xs.length - 1]![0];
};
const between = (lo: number, hi: number, step = 1) => Math.round((lo + rand() * (hi - lo)) / step) * step;

// ------------------------------------------------------------------------------------------- account

async function findAuthUser(email: string): Promise<string | null> {
  const rows = (await adminDb.execute(sql`select id::text as id from auth.users where lower(email) = ${email} limit 1`)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

async function ensureAuthUser(email: string): Promise<string> {
  const existing = await findAuthUser(email);
  if (existing) return existing;
  if (!DEMO_PASSWORD || DEMO_PASSWORD.length < 8 || DEMO_PASSWORD.length > 72)
    fail(`${email} has no account yet. Set DEMO_PASSWORD (8–72 characters) in .env, or sign up once in the app with this address, then rerun.`);
  const { hashPassword } = await import("@/server/auth/password");
  const { authUsers } = await import("@/db/auth-schema");
  const [created] = await adminDb.insert(authUsers).values({ email, passwordHash: await hashPassword(DEMO_PASSWORD) }).returning({ id: authUsers.id });
  if (!created) fail(`could not create the account ${email}`);
  console.log(`created the sign-in account ${email}`);
  return created.id;
}

async function ensureOrganization(userId: string, email: string): Promise<OrgAccess> {
  const [member] = await adminDb
    .select({ organizationId: schema.users.organizationId, role: schema.users.role, name: schema.organizations.name, type: schema.organizations.organizerType })
    .from(schema.users)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.users.organizationId))
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (member) {
    if (member.role !== "owner" && member.role !== "admin") fail(`${email} is ${member.role} in "${member.name}"; the demo account must be owner or admin.`);
    return { userId, organizationId: member.organizationId, organizationName: member.name, organizerType: member.type, role: member.role };
  }
  return adminDb.transaction(async (tx) => {
    const [org] = await tx.insert(schema.organizations).values({ name: ORG_NAME, organizerType: ORG_TYPE }).returning();
    await tx.insert(schema.users).values({ id: userId, organizationId: org!.id, email, role: "owner" });
    console.log(`created organization "${ORG_NAME}" with ${email} as owner`);
    return { userId, organizationId: org!.id, organizationName: org!.name, organizerType: org!.organizerType, role: "owner" as const };
  });
}

// ------------------------------------------------------------------------------------------- pipeline

async function generation(org: OrgAccess, kind: string, eventId: string | undefined, output: unknown) {
  const id = await startGeneration(org, {
    eventId, kind, prompt: "Sunum için hazırlanmış örnek veri (demo:seed).", schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    provider: "seed", model: "demo-seed", temperature: 0,
  });
  await finishGeneration(org, id, { status: "SUCCEEDED", output, latencyMs: 0 });
  return id;
}

async function createFromBlueprint(org: OrgAccess, draft: BlueprintCoreDraft, organizerModules: ModuleKey[]) {
  const r = normalizeBlueprintCore(draft, { today, organizationType: org.organizerType, organizerModules });
  if (!r.ok) fail(`core draft for "${draft.event.title}" is invalid: ${r.error.message}`);
  const gid = await generation(org, "blueprint.core", undefined, draft);
  const p = await saveProposal({ org, eventId: null }, gid, coreProposal(r.core));
  const s = await applyProposal({ proposalId: p.id, organizationId: org.organizationId, actorId: org.userId });
  return { eventId: s.eventId, core: r.core };
}

type TaskSeed = [key: string, title: string, workstream: string, board: "PLANNING" | "OPERATIONS" | "MEASUREMENT", priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW", offset: number, role: string, depends?: string[]];

function tasksDraft(core: BlueprintCore, seeds: TaskSeed[]) {
  const ws = new Set(vocabularyFor(core.modules.map((m) => m.key)).workstreams);
  const fallback = ws.has("logistics") ? "logistics" : "strategy";
  return {
    tasks: seeds.map(([key, title, workstream, board, priority, offset, role, depends]) => ({
      key, title, description: null, workstream: ws.has(workstream) ? workstream : fallback, board,
      phase: (offset > 0 ? (board === "MEASUREMENT" ? "ANALYZE" : "IMPROVE") : offset === 0 ? "RUN" : offset <= -30 ? "PLAN" : offset <= -7 ? "PREPARE" : "MANAGE") as "PLAN",
      priority, dueOffsetDays: offset, assigneeRole: role, dependsOnKeys: depends ?? [], stakeholderKind: null,
    })),
    assumptions: [],
  };
}

async function proposeTasks(org: OrgAccess, eventId: string, core: BlueprintCore, seeds: TaskSeed[], apply: boolean, card?: { title: string; rationale: string }) {
  const draft = tasksDraft(core, seeds);
  const r = normalizeTasks(draft as never, core);
  const gid = await generation(org, "blueprint.tasks", eventId, draft);
  const proposal = tasksProposal(r.tasks, r.warnings);
  if (card) Object.assign(proposal, card);
  const p = await saveProposal({ org, eventId, today }, gid, proposal);
  if (apply) await applyProposal({ proposalId: p.id, organizationId: org.organizationId, actorId: org.userId });
  return p.id;
}

/** Sample questions for the other roles of the single survey link (sample data, no model call). */
type ExtraQ = { key: string; type: "LIKERT_5" | "YES_NO" | "SINGLE_CHOICE" | "OPEN_TEXT" | "NUMBER"; text: string; required: boolean; options: { value: string; label: string }[] | null };
const STAKEHOLDER_QUESTIONS: Partial<Record<string, ExtraQ[]>> = {
  EXHIBITOR: [
    { key: "stand_satisfaction", type: "LIKERT_5", text: "Stant katılımınızdan genel olarak ne kadar memnun kaldınız?", required: true, options: null },
    { key: "stand_traffic", type: "SINGLE_CHOICE", text: "Standınıza gelen ziyaretçi yoğunluğunu nasıl değerlendirirsiniz?", required: true,
      options: [{ value: "low", label: "Beklentinin altında" }, { value: "expected", label: "Beklendiği gibi" }, { value: "high", label: "Beklentinin üstünde" }] },
    { key: "stand_return", type: "YES_NO", text: "Gelecek yıl yine stant açmayı düşünür müsünüz?", required: false, options: null },
  ],
  LOCAL_BUSINESS: [
    { key: "business_sector", type: "SINGLE_CHOICE", text: "İşletmenizin faaliyet alanı nedir?", required: true,
      options: [{ value: "food", label: "Yeme-içme" }, { value: "lodging", label: "Konaklama" }, { value: "retail", label: "Perakende" }, { value: "other", label: "Diğer" }] },
    { key: "business_effect", type: "SINGLE_CHOICE", text: "Etkinlik günlerinde işletmenizin cirosu normal günlere göre nasıldı?", required: true,
      options: [{ value: "lower", label: "Daha düşük" }, { value: "same", label: "Aynı" }, { value: "higher", label: "Daha yüksek" }] },
    { key: "business_support", type: "LIKERT_5", text: "Etkinliğin yeniden düzenlenmesini ne ölçüde desteklersiniz?", required: false, options: null },
  ],
  SPONSOR: [
    { key: "sponsor_visibility", type: "LIKERT_5", text: "Markanızın etkinlikteki görünürlüğünden ne kadar memnun kaldınız?", required: true, options: null },
    { key: "sponsor_renew", type: "YES_NO", text: "Sponsorluğunuzu gelecek yıl sürdürmeyi düşünür müsünüz?", required: true, options: null },
    { key: "sponsor_note", type: "OPEN_TEXT", text: "Sponsorluk deneyiminizle ilgili eklemek istedikleriniz", required: false, options: null },
  ],
};

/** Sample answers of the other roles (stand owners, local businesses, sponsors) on the live festival. */
const STAKEHOLDER_ANSWERS: [string, number][] = [["EXHIBITOR", 26], ["LOCAL_BUSINESS", 34], ["SPONSOR", 3]];

/**
 * Databases seeded before the single survey link: add the other roles' surveys to the live festival (only audiences
 * without a survey, so the open visitor survey is never touched), open them and add sample answers.
 */
async function topUpRoleSurveys(org: OrgAccess, eventId: string) {
  const have = new Set((await adminDb.select({ audience: schema.surveys.audience }).from(schema.surveys)
    .where(and(eq(schema.surveys.organizationId, org.organizationId), eq(schema.surveys.eventId, eventId)))).map((r) => r.audience as string));
  const missing = STAKEHOLDER_ANSWERS.filter(([a]) => !have.has(a));
  if (!missing.length) return 0;
  const core = await loadApprovedCore(org.organizationId, eventId);
  const k = normalizeKpis({ kpis: FESTIVAL_KPIS }, core);
  const req = deriveDataRequirements(k.kpis);
  const sDraft = {
    surveys: missing.map(([audience]) => ({
      audience: audience as "EXHIBITOR", title: SURVEY_TEXT[audience as keyof typeof SURVEY_TEXT]?.title ?? `${core.event.title} anketi`,
      intro: SURVEY_TEXT[audience as keyof typeof SURVEY_TEXT]?.intro ?? "Bu kısa anket etkinliği değerlendirmek için hazırlandı. Yaklaşık 2 dakika sürer.",
      extraQuestions: STAKEHOLDER_QUESTIONS[audience] ?? [],
    })),
  };
  const planned = normalizeSurveys(sDraft, core, k.kpis, req).surveys.filter((x) => missing.some(([a]) => a === x.audience));
  if (!planned.length) return 0;
  const sg = await generation(org, "blueprint.surveys", eventId, sDraft);
  const sp = await saveProposal({ org, eventId, today }, sg, surveysProposal(planned));
  await applyProposal({ proposalId: sp.id, organizationId: org.organizationId, actorId: org.userId });
  let n = 0;
  for (const [audience, count] of missing) n += await collectResponses(org, eventId, audience, count, 30);
  return n;
}

async function proposeKpisAndSurveys(
  org: OrgAccess, eventId: string, core: BlueprintCore,
  wanted: { metricKey: string; objectiveIndex: number | null; target: number | null; targetBasis: string | null; rationale: string }[],
  surveyText: Partial<Record<string, { title: string; intro: string }>>,
  apply: boolean,
) {
  const candidates = new Set(candidateMetrics(core.event.format, core.modules.map((m) => m.key)).map((c) => c.key));
  const draft = { kpis: wanted.filter((k) => candidates.has(k.metricKey)) };
  const k = normalizeKpis(draft, core);
  const req = deriveDataRequirements(k.kpis);
  const measurement = deriveMeasurementTasks(req, core);
  const proposal = kpisProposal(k.kpis, k.warnings, {});
  proposal.operations.push(...measurement.map((data) => ({ op: "upsert" as const, entity: "task" as const, data })));
  proposal.title = `${k.kpis.length} KPI ve ${measurement.length} ölçüm görevi`;
  const kg = await generation(org, "blueprint.kpis", eventId, draft);
  const kp = await saveProposal({ org, eventId, today }, kg, proposal);
  if (apply) await applyProposal({ proposalId: kp.id, organizationId: org.organizationId, actorId: org.userId });

  const audiences = surveyAudiencesFor(core, req);
  const sDraft = {
    surveys: audiences.map((audience) => ({
      audience,
      title: surveyText[audience]?.title ?? `${core.event.title} anketi`,
      intro: surveyText[audience]?.intro ?? "Bu kısa anket etkinliğin değerlendirilmesi için hazırlanmıştır. Yaklaşık 3 dakika sürer.",
      extraQuestions: audience === "ATTENDEE"
        ? [{
            key: "favorite_area", type: "SINGLE_CHOICE" as const, text: "Etkinlikte en çok hangi alanı beğendiniz?", required: false,
            options: [
              { value: "food", label: "Yeme-içme alanı" }, { value: "stage", label: "Sahne programı" },
              { value: "workshops", label: "Atölyeler" }, { value: "stands", label: "Üretici stantları" },
            ],
          }]
        : STAKEHOLDER_QUESTIONS[audience] ?? [],
    })),
  };
  const r = normalizeSurveys(sDraft, core, k.kpis, req);
  if (!r.surveys.length) return;
  const sg = await generation(org, "blueprint.surveys", eventId, sDraft);
  const sp = await saveProposal({ org, eventId, today }, sg, surveysProposal(r.surveys));
  if (apply) await applyProposal({ proposalId: sp.id, organizationId: org.organizationId, actorId: org.userId });
}

async function setEvent(org: OrgAccess, eventId: string, values: { status?: "draft" | "live" | "completed"; startDate?: string; endDate?: string }) {
  const [before] = await adminDb.select({ startDate: schema.events.startDate }).from(schema.events).where(eq(schema.events.id, eventId));
  await adminDb.update(schema.events).set({ ...values, updatedAt: new Date() })
    .where(and(eq(schema.events.id, eventId), eq(schema.events.organizationId, org.organizationId)));
  if (values.startDate && before?.startDate !== values.startDate) await reflowTaskDueDates(org.organizationId, eventId, before?.startDate ?? null, values.startDate);
}

/** Realistic progress: past-due tasks mostly done, a few still open (shown as overdue), current ones in progress. */
async function progressTasks(org: OrgAccess, eventId: string, mode: "live" | "early" | "all_done") {
  const rows = await adminDb.select({ id: schema.tasks.id, dueDate: schema.tasks.dueDate }).from(schema.tasks)
    .where(and(eq(schema.tasks.organizationId, org.organizationId), eq(schema.tasks.eventId, eventId)));
  const done: string[] = [];
  const inProgress: string[] = [];
  for (const t of rows) {
    if (mode === "all_done") { done.push(t.id); continue; }
    if (!t.dueDate) continue;
    const days = Math.round((Date.parse(t.dueDate) - Date.parse(today)) / 86_400_000);
    if (mode === "live") {
      if (days < -2) (rand() < 0.88 ? done : inProgress).push(t.id);
      else if (days <= 1) (rand() < 0.5 ? inProgress : done).push(t.id);
      else if (days <= 4 && rand() < 0.3) inProgress.push(t.id);
    } else if (days < 0) done.push(t.id);
    else if (days < 10 && rand() < 0.4) inProgress.push(t.id);
  }
  if (done.length) await adminDb.update(schema.tasks).set({ status: "DONE", updatedAt: new Date() }).where(inArray(schema.tasks.id, done));
  if (inProgress.length) await adminDb.update(schema.tasks).set({ status: "IN_PROGRESS", updatedAt: new Date() }).where(inArray(schema.tasks.id, inProgress));
}

type BudgetSeed = [kind: "INCOME" | "COST" | "TICKET_ADJUSTMENT", category: string, label: string, planned: number | null, actual: number | null,
  extra?: { quantity?: number; costBehavior?: "FIXED" | "VARIABLE"; supplierLocal?: boolean; fundedExternally?: boolean }];
async function seedBudget(org: OrgAccess, eventId: string, lines: BudgetSeed[]) {
  for (const [kind, category, label, planned, actual, extra] of lines) {
    await createBudgetItem(org, eventId, {
      organizationId: org.organizationId, kind, category, label, planned, actual, quantity: extra?.quantity ?? null,
      costBehavior: extra?.costBehavior ?? null, supplierLocal: extra?.supplierLocal ?? null, fundedExternally: extra?.fundedExternally ?? null, notes: null,
    });
  }
  return lines.length;
}
const local = (costBehavior: "FIXED" | "VARIABLE", supplierLocal: boolean, fundedExternally: boolean) => ({ costBehavior, supplierLocal, fundedExternally });

async function issueTickets(org: OrgAccess, eventId: string, plan: [type: string, total: number, checkedIn: number][], cancelled: number, window: [hoursAgoFrom: number, hoursAgoTo: number]) {
  for (const [ticketType, total] of plan) {
    for (let left = total; left > 0; left -= 500)
      await registerAttendees(eventId, { organizationId: org.organizationId, ticketType, quantity: Math.min(500, left) });
  }
  const [from, to] = window;
  for (const [ticketType, , checkedIn] of plan) {
    await adminDb.execute(sql`
      update attendees set is_checked_in = true, updated_at = now(),
        checked_in_at = now() - make_interval(secs => (${to} + random() * ${from - to}) * 3600)
      where id in (select id from attendees where organization_id = ${org.organizationId} and event_id = ${eventId}
        and ticket_type = ${ticketType} and not is_checked_in order by random() limit ${checkedIn})`);
  }
  if (cancelled > 0)
    await adminDb.execute(sql`
      update attendees set cancelled_at = now() - make_interval(secs => random() * 172800), updated_at = now()
      where id in (select id from attendees where organization_id = ${org.organizationId} and event_id = ${eventId}
        and not is_checked_in and cancelled_at is null order by random() limit ${cancelled})`);
}

// ------------------------------------------------------------------------------------------- answers

const VISITOR_PROVINCES: [number, number][] = [[34, 30], [6, 10], [45, 9], [9, 7], [16, 7], [7, 6], [48, 6], [20, 5], [10, 5], [35, 0], [0, 3], [26, 3], [41, 3], [3, 3]];
const SPEND_RANGE: Record<string, [number, number, number]> = {
  ACCOMMODATION: [1200, 7000, 0.75], FOOD_BEVERAGE: [250, 2600, 0.97], LOCAL_TRANSPORT: [60, 700, 0.8],
  INTERCITY_TRANSPORT: [300, 3500, 0.7], RETAIL_SHOPPING: [100, 2200, 0.6], ENTERTAINMENT_CULTURE: [80, 900, 0.45],
  VENUE_AND_SERVICES: [50, 600, 0.3], MARKETING_PRINTING: [0, 200, 0.05], OTHER: [50, 800, 0.35],
};
const OPEN_TEXTS = ["Oturma alanları artırılabilir.", "Yönlendirme tabelaları daha görünür olmalı.", "Akşam saatlerinde sıra beklemek uzun sürdü.", "Çocuklar için daha fazla etkinlik olabilir.", "Ücretsiz su noktaları çok iyiydi."];

type Q = import("@/lib/api/types").SurveyQuestion;
function answersFor(questions: Q[]) {
  const a: Record<string, unknown> = {};
  const visible = (q: Q) => !q.showIf || a[q.showIf.key] === q.showIf.equals;
  let nights = 0;
  for (const q of questions) {
    if (!visible(q) || q.isSensitive) continue;
    const optional = !q.required;
    switch (q.key) {
      case "q_is_local": a[q.key] = rand() < 0.32; continue;
      case "q_home_province": a[q.key] = a.q_is_local === true ? 35 : weighted(VISITOR_PROVINCES); continue;
      case "q_party_size": a[q.key] = weighted([[1, 20], [2, 35], [3, 18], [4, 18], [5, 6], [6, 3]]); continue;
      case "q_days_present": a[q.key] = weighted([[1, 45], [2, 35], [3, 20]]); continue;
      case "q_nights_stayed": nights = weighted([[0, 30], [1, 25], [2, 30], [3, 15]]); a[q.key] = nights; continue;
      case "q_main_reason": a[q.key] = weighted([["event", 55], ["event_and_other", 30], ["other", 15]]); continue;
      case "q_would_visit_anyway": a[q.key] = weighted([["no", 50], ["maybe", 30], ["yes", 20]]); continue;
      case "q_attended_before": a[q.key] = rand() < 0.35; continue;
    }
    if (optional && q.type !== "CURRENCY_TRY" && rand() < 0.25) continue;
    switch (q.type) {
      case "LIKERT_5": case "rating": a[q.key] = weighted([[1, 3], [2, 6], [3, 18], [4, 42], [5, 31]]); break;
      case "NPS_0_10": a[q.key] = weighted([[4, 2], [5, 3], [6, 5], [7, 12], [8, 22], [9, 26], [10, 30]]); break;
      case "YES_NO": case "boolean": a[q.key] = rand() < 0.5; break;
      case "SINGLE_CHOICE": a[q.key] = pick(q.options ?? [{ value: "x", label: "x" }]).value; break;
      case "MULTI_CHOICE": {
        const opts = [...(q.options ?? [])].sort(() => rand() - 0.5).slice(0, 1 + Math.floor(rand() * 2));
        a[q.key] = opts.map((o) => o.value);
        break;
      }
      case "NUMBER": a[q.key] = between(1, 5); break;
      case "PERCENT": a[q.key] = between(-10, 40); break;
      case "PROVINCE": a[q.key] = weighted(VISITOR_PROVINCES); break;
      case "CURRENCY_TRY": {
        const [lo, hi, p] = SPEND_RANGE[q.spendCategory ?? "OTHER"] ?? [50, 500, 0.5];
        if (q.spendCategory === "ACCOMMODATION" && nights === 0) { a[q.key] = 0; break; }
        if (rand() < p) a[q.key] = between(lo, hi, 10);
        else if (rand() < 0.5) a[q.key] = 0;
        break;
      }
      case "OPEN_TEXT": case "text": if (q.required || rand() < 0.2) a[q.key] = pick(OPEN_TEXTS); break;
    }
  }
  return a;
}

async function collectResponses(org: OrgAccess, eventId: string, audience: string, count: number, spreadHours: number, close = false) {
  const [s] = await adminDb.select({ id: schema.surveys.id }).from(schema.surveys)
    .where(and(eq(schema.surveys.organizationId, org.organizationId), eq(schema.surveys.eventId, eventId), eq(schema.surveys.audience, audience as "ATTENDEE")))
    .limit(1);
  if (!s) return 0;
  await setSurveyStatus(org.organizationId, s.id, "open");
  const detail = await getSurveyDetail(org.organizationId, s.id, true);
  let ok = 0;
  for (let i = 0; i < count; i += 10) {
    const batch = Array.from({ length: Math.min(10, count - i) }, () =>
      submitPublicResponse(detail.publicToken!, { answers: answersFor(detail.questions as Q[]), sensitiveConsent: false }).then(() => ok++, () => undefined),
    );
    await Promise.all(batch);
  }
  await adminDb.execute(sql`update survey_responses set submitted_at = now() - make_interval(secs => random() * ${spreadHours * 3600})
    where organization_id = ${org.organizationId} and survey_id = ${s.id}`);
  if (close) await setSurveyStatus(org.organizationId, s.id, "close");
  return ok;
}

// ------------------------------------------------------------------------------------------- content

const LIVE: BlueprintCoreDraft = {
  event: {
    title: "Kordon Gastronomi Festivali",
    summary: "İzmir Kordon boyunca üç gün süren, yerel üreticileri, şefleri ve ziyaretçileri buluşturan açık hava gastronomi festivali.",
    format: "FESTIVAL", deliveryMode: "IN_PERSON", primaryLanguage: "tr", bilingual: false, city: "İzmir", venueName: "Kordon Boyu",
    startDate: today, durationDays: 3, dailyStartTime: "10:00", dailyEndTime: "22:00", expectedAttendance: 5000, capacity: null,
  },
  objectives: [
    { text: "Şehir dışından ziyaretçi çekmek", origin: "EXPLICIT" },
    { text: "Yerel üretici ve restoranların satışlarını artırmak", origin: "EXPLICIT" },
    { text: "Ziyaretçi memnuniyetini ve harcamasını ölçmek", origin: "EXPLICIT" },
    { text: "Festivali her yıl tekrarlanan bir şehir markasına dönüştürmek", origin: "INFERRED" },
  ],
  audience: "Gastronomiye ilgi duyan aileler, gençler ve şehir dışından gelen ziyaretçiler",
  clientOrganizerType: null, clientName: null, budgetTotalTry: null,
  proposedModules: [
    { key: "stages", reason: "Şef gösterileri ve akşam konserleri için sahne programı var." },
    { key: "booths", reason: "Yerel üretici ve restoran stantları festivalin merkezinde." },
    { key: "sponsorship", reason: "Ana sponsor ve tedarikçi iş birlikleri planlanıyor." },
    { key: "economic_impact", reason: "Ziyaretçi harcamasının yerel ekonomiye etkisi ölçülecek." },
  ],
  stakeholders: [
    { kind: "PUBLIC_AUTHORITY", name: "Belediye izin ve zabıta birimleri", role: "Alan kullanım izni ve denetim", origin: "INFERRED" },
    { kind: "LOCAL_BUSINESS", name: "Yerel üretici kooperatifleri", role: "Stant katılımcıları", origin: "EXPLICIT" },
    { kind: "SPONSOR", name: "Ana sponsor (aranıyor)", role: "Sahne ve görünürlük desteği", origin: "INFERRED" },
    { kind: "MEDIA", name: "Yerel basın", role: "Duyuru ve haber", origin: "INFERRED" },
  ],
  clarifications: [],
  assumptions: ["Giriş ücretsiz ve QR biletli; bilet kapıda okutulur.", "Ziyaretçilerin günlere eşit dağıldığı varsayıldı."],
};

const LIVE_TASKS: TaskSeed[] = [
  ["permit_venue", "Alan kullanım iznini belediyeden al", "permits", "PLANNING", "CRITICAL", -60, "Proje yöneticisi"],
  ["budget_final", "Festival bütçesini kesinleştir", "finance", "PLANNING", "HIGH", -55, "Finans sorumlusu"],
  ["sponsor_pack", "Sponsorluk dosyasını hazırla ve gönder", "sponsorship", "PLANNING", "HIGH", -50, "Sponsorluk sorumlusu"],
  ["vendor_call", "Üretici ve restoran başvurularını topla", "booth_management", "PLANNING", "HIGH", -45, "Stant koordinatörü"],
  ["vendor_select", "Stant katılımcılarını seç ve sözleşmeleri imzala", "booth_management", "PLANNING", "HIGH", -30, "Stant koordinatörü", ["vendor_call"]],
  ["stage_program", "Şef gösterisi ve konser programını kesinleştir", "stage_production", "PLANNING", "HIGH", -28, "Program sorumlusu"],
  ["marketing_launch", "Duyuru kampanyasını başlat", "marketing", "PLANNING", "MEDIUM", -25, "İletişim sorumlusu"],
  ["safety_plan", "Alan güvenlik ve acil durum planını yayımla", "safety_security", "PLANNING", "CRITICAL", -21, "Güvenlik sorumlusu"],
  ["supplier_list", "Tedarikçi listesini onayla", "logistics", "PLANNING", "MEDIUM", -20, "Satın alma sorumlusu"],
  ["volunteer_shift", "Gönüllü vardiya planını oluştur", "staffing", "PLANNING", "MEDIUM", -14, "Gönüllü koordinatörü"],
  ["ticket_issue", "QR biletleri çıkar ve dağıt", "registration", "PLANNING", "HIGH", -10, "Kayıt sorumlusu"],
  ["signage", "Alan yönlendirme levhalarını yerleştir", "site_operations", "OPERATIONS", "MEDIUM", -3, "Operasyon sorumlusu"],
  ["stage_setup", "Sahne kurulum kontrolünü yap", "stage_production", "OPERATIONS", "HIGH", -2, "Teknik yönetmen", ["stage_program"]],
  ["power_plan", "Stant alanı elektrik dağıtımını test et", "site_operations", "OPERATIONS", "MEDIUM", -2, "Teknik ekip"],
  ["gate_rehearsal", "QR kapı geçiş provasını yap", "registration", "OPERATIONS", "HIGH", -1, "Kapı sorumlusu", ["ticket_issue"]],
  ["food_safety", "Gıda güvenliği denetim turunu tamamla", "safety_security", "OPERATIONS", "CRITICAL", -1, "Saha koordinatörü"],
  ["gate_open", "Kapıları aç ve giriş akışını izle", "site_operations", "OPERATIONS", "CRITICAL", 0, "Kapı sorumlusu"],
  ["crowd_watch", "Yoğun saatlerde kalabalık yoğunluğunu izle", "crowd_management", "OPERATIONS", "HIGH", 1, "Güvenlik sorumlusu"],
  ["waste_ops", "Gün sonu atık toplama ve ayrıştırmayı yürüt", "site_operations", "OPERATIONS", "MEDIUM", 2, "Saha koordinatörü"],
  ["teardown", "Alan söküm ve teslimini tamamla", "logistics", "OPERATIONS", "MEDIUM", 3, "Operasyon sorumlusu"],
  ["vendor_feedback", "Stant katılımcılarından geri bildirim topla", "booth_management", "MEASUREMENT", "MEDIUM", 5, "Stant koordinatörü"],
  ["final_report", "Festival kapanış raporunu hazırla", "reporting", "MEASUREMENT", "HIGH", 14, "Proje yöneticisi"],
];

const LIVE_EXTRA_TASKS: TaskSeed[] = [
  ["food_safety_plan", "Gıda güvenliği denetim planını ikinci gün için güncelle", "safety_security", "OPERATIONS", "HIGH", 1, "Saha koordinatörü"],
  ["waste_team", "Atık yönetimi ekibini akşam vardiyası için kesinleştir", "site_operations", "OPERATIONS", "HIGH", 1, "Saha koordinatörü"],
  ["route_check", "Alan yönlendirme kontrolünü sabah açılıştan önce yap", "site_operations", "OPERATIONS", "MEDIUM", 1, "Operasyon sorumlusu"],
  ["emergency_list", "Acil durum iletişim listesini tüm ekiplere dağıt", "safety_security", "OPERATIONS", "HIGH", 0, "Güvenlik sorumlusu"],
];

const FESTIVAL_KPIS = [
  { metricKey: "show_up_rate", objectiveIndex: null, target: 70, targetBasis: "Biletli ücretsiz etkinliklerde hedeflenen giriş oranı", rationale: "Bilet alanların ne kadarının geldiğini gösterir." },
  { metricKey: "visitor_share", objectiveIndex: 0, target: null, targetBasis: null, rationale: "Şehir dışından gelen ziyaretçi payı birinci hedefi ölçer." },
  { metricKey: "mean_spend_per_visitor_day", objectiveIndex: 1, target: null, targetBasis: null, rationale: "Yerel ekonomiye giren harcamanın temelidir." },
  { metricKey: "attributable_visitor_spend", objectiveIndex: 1, target: null, targetBasis: null, rationale: "Festival olmasa gerçekleşmeyecek harcamayı ayırır." },
  { metricKey: "overall_satisfaction", objectiveIndex: 2, target: 4, targetBasis: "Düzenleyicinin 5 üzerinden 4 beklentisi", rationale: "Ziyaretçi deneyiminin genel göstergesi." },
  { metricKey: "nps", objectiveIndex: 3, target: null, targetBasis: null, rationale: "Tavsiye eğilimi, festivalin tekrarlanabilirliğini gösterir." },
  { metricKey: "repeat_attendance_rate", objectiveIndex: 3, target: null, targetBasis: null, rationale: "Daha önce gelenlerin payı marka bağlılığını gösterir." },
];

const TECH: BlueprintCoreDraft = {
  event: {
    title: "OZBDA Gençlik ve Teknoloji Haftası", summary: "Üniversite öğrencileri ve genç girişimcileri teknoloji şirketleriyle buluşturan beş günlük program.",
    format: "CONFERENCE", deliveryMode: "IN_PERSON", primaryLanguage: "tr", bilingual: false, city: "İzmir", venueName: null,
    startDate: addDays(today, 16), durationDays: 5, dailyStartTime: "10:00", dailyEndTime: "18:00", expectedAttendance: 3000, capacity: null,
  },
  objectives: [
    { text: "Gençleri teknoloji şirketleriyle buluşturmak", origin: "EXPLICIT" },
    { text: "Yeni iş birlikleri ve staj olanakları oluşturmak", origin: "EXPLICIT" },
  ],
  audience: "Üniversite öğrencileri, genç girişimciler ve teknoloji şirketleri",
  clientOrganizerType: null, clientName: null, budgetTotalTry: null,
  proposedModules: [
    { key: "sessions", reason: "Atölye ve panel oturumları planlanıyor." },
    { key: "speakers", reason: "Sektörden konuşmacılar davet edilecek." },
    { key: "booths", reason: "Şirket stantları kurulacak." },
    { key: "sponsorship", reason: "Teknoloji şirketlerinden sponsorluk bekleniyor." },
  ],
  stakeholders: [
    { kind: "SPONSOR", name: "Teknoloji sponsorları (aranıyor)", role: "Stant ve ödül desteği", origin: "INFERRED" },
    { kind: "SPEAKER", name: "Sektör konuşmacıları", role: "Panel ve atölye", origin: "EXPLICIT" },
  ],
  clarifications: [],
  assumptions: ["Katılım ücretsiz, ön kayıt ile.", "Program her gün iki salonda paralel yürür."],
};

const TECH_TASKS: TaskSeed[] = [
  ["venue_book", "Etkinlik salonlarını rezerve et", "venue", "PLANNING", "CRITICAL", -40, "Proje yöneticisi"],
  ["speaker_invite", "Konuşmacı davetlerini gönder", "speaker_management", "PLANNING", "HIGH", -35, "Program sorumlusu"],
  ["agenda_draft", "Oturum planının ilk taslağını hazırla", "agenda", "PLANNING", "HIGH", -30, "Program sorumlusu"],
  ["sponsor_meetings", "Sponsor görüşmelerini tamamla", "sponsorship", "PLANNING", "HIGH", -21, "Sponsorluk sorumlusu"],
  ["registration_open", "Ön kayıt formunu yayına al", "registration", "PLANNING", "HIGH", -20, "Kayıt sorumlusu"],
  ["booth_layout", "Stant yerleşim planını çiz", "booth_management", "PLANNING", "MEDIUM", -14, "Stant koordinatörü"],
  ["campus_promo", "Kampüs duyurularını başlat", "marketing", "PLANNING", "MEDIUM", -14, "İletişim sorumlusu"],
  ["av_check", "Ses ve görüntü sistemlerini test et", "venue", "OPERATIONS", "HIGH", -1, "Teknik ekip"],
  ["badge_print", "Yaka kartlarını bas", "registration", "OPERATIONS", "MEDIUM", -2, "Kayıt sorumlusu"],
  ["day_ops", "Günlük oturum akışını yönet", "agenda", "OPERATIONS", "HIGH", 0, "Program sorumlusu"],
  ["closing_report", "Hafta sonu değerlendirme raporunu yaz", "reporting", "MEASUREMENT", "MEDIUM", 10, "Proje yöneticisi"],
];

const BOOK: BlueprintCoreDraft = {
  event: {
    title: "Ege Kitap Günleri", summary: "Yayınevleri, yazarlar ve okurları buluşturan dört günlük kitap fuarı ve söyleşi programı.",
    format: "CULTURAL", deliveryMode: "IN_PERSON", primaryLanguage: "tr", bilingual: false, city: "İzmir", venueName: null,
    startDate: addDays(today, 30), durationDays: 4, dailyStartTime: "10:00", dailyEndTime: "20:00", expectedAttendance: 2500, capacity: null,
  },
  objectives: [
    { text: "Okuma kültürünü yaygınlaştırmak", origin: "EXPLICIT" },
    { text: "Bölgedeki yayınevlerinin satışlarını desteklemek", origin: "EXPLICIT" },
  ],
  audience: "Okurlar, öğrenciler ve aileler", clientOrganizerType: null, clientName: null, budgetTotalTry: null,
  proposedModules: [
    { key: "booths", reason: "Yayınevi stantları fuarın merkezinde." },
    { key: "economic_impact", reason: "Ziyaretçi harcaması ölçülecek." },
  ],
  stakeholders: [{ kind: "EXHIBITOR", name: "Bölge yayınevleri", role: "Stant katılımcıları", origin: "EXPLICIT" }],
  clarifications: [],
  assumptions: ["Giriş ücretsiz ve biletli."],
};

const BOOK_TASKS: TaskSeed[] = [
  ["publisher_call", "Yayınevi başvurularını topla", "booth_management", "PLANNING", "HIGH", -45, "Stant koordinatörü"],
  ["author_program", "Yazar söyleşi programını hazırla", "program", "PLANNING", "HIGH", -30, "Program sorumlusu"],
  ["hall_setup", "Fuar alanı kurulumunu tamamla", "venue", "OPERATIONS", "CRITICAL", -1, "Operasyon sorumlusu"],
  ["daily_ops", "Günlük giriş ve stant operasyonunu yönet", "logistics", "OPERATIONS", "HIGH", 0, "Operasyon sorumlusu"],
  ["closing", "Kapanış değerlendirmesini yap", "reporting", "MEASUREMENT", "MEDIUM", 7, "Proje yöneticisi"],
];

const SURVEY_TEXT = {
  ATTENDEE: { title: "Ziyaretçi Harcama ve Deneyim Anketi", intro: "Bu kısa anket festivalin ziyaretçi deneyimini ve yerel ekonomiye katkısını değerlendirmek için hazırlandı. Yaklaşık 3 dakika sürer." },
  LOCAL_BUSINESS: { title: "Yerel İşletme Etki Anketi", intro: "Festival süresince işletmenizdeki değişimi anlamak için hazırlandı. Yaklaşık 2 dakika sürer." },
  EXHIBITOR: { title: "Stant Katılımcısı Anketi", intro: "Stant deneyiminizi değerlendirmek için hazırlandı. Yaklaşık 2 dakika sürer." },
  SPONSOR: { title: "Sponsor Değerlendirme Anketi", intro: "Sponsorluk deneyiminizi değerlendirmek için hazırlandı. Yaklaşık 2 dakika sürer." },
};

// ------------------------------------------------------------------------------------------- run

const userId = await ensureAuthUser(DEMO_EMAIL);
const org = await ensureOrganization(userId, DEMO_EMAIL);
const existing = await adminDb.select({ id: schema.events.id }).from(schema.events)
  .where(and(eq(schema.events.organizationId, org.organizationId), eq(schema.events.title, LIVE.event.title))).limit(1);
if (existing.length) {
  // only addition for databases seeded earlier: the other roles' surveys behind the single survey link
  const added = await topUpRoleSurveys(org, existing[0]!.id);
  console.log(added
    ? `"${org.organizationName}" already had the demo events; added the stand owner, local business and sponsor surveys (${added} sample answers).`
    : `"${org.organizationName}" already has the demo events; nothing changed.`);
  process.exit(0);
}

console.log(`seeding "${org.organizationName}" (${DEMO_EMAIL}) — today ${today}`);

// 1. Live festival: full plan applied, tickets and check-ins, open survey with answers, one stored impact run.
const live = await createFromBlueprint(org, LIVE, ["registration"]);
await proposeTasks(org, live.eventId, live.core, LIVE_TASKS, true);
await proposeKpisAndSurveys(org, live.eventId, live.core, FESTIVAL_KPIS, SURVEY_TEXT, true);
await setEvent(org, live.eventId, { status: "live" });
await progressTasks(org, live.eventId, "live");
await issueTickets(org, live.eventId, [["Genel", 3600, 2390], ["Öğrenci", 800, 540], ["Davetli", 300, 190], ["Basın", 120, 55]], 41, [7, 0.05]);
const liveResponses = await collectResponses(org, live.eventId, "ATTENDEE", 420, 30);
for (const [audience, count] of STAKEHOLDER_ANSWERS) await collectResponses(org, live.eventId, audience, count, 30);
await putImpactInputs(live.eventId, userId, { organizationId: org.organizationId, priceYear: Number(today.slice(0, 4)), attributionMethod: "SURVEY_STRICT", deadweight: null, displacement: null, leakage: null, multiplierSetId: null });
const run = await runImpactCalculation(live.eventId, userId, { organizationId: org.organizationId, level: "ECONOMIC_IMPACT" });
await seedBudget(org, live.eventId, [
  ["INCOME", "TICKETS", "Bilet satışı (Genel, Öğrenci)", 1_150_000, 1_092_400, { quantity: 4_400 }],
  ["INCOME", "SPONSORSHIP", "Ana sponsor sözleşmesi", 600_000, 600_000],
  ["INCOME", "EXHIBITOR", "Gıda standı kiraları (42 stant)", 336_000, 315_000],
  ["INCOME", "GRANT", "Büyükşehir kültür-turizm desteği", 250_000, null],
  ["COST", "VENUE", "Kordon alanı kullanım bedeli ve kurulum", 280_000, 296_500, local("FIXED", true, true)],
  ["COST", "PRODUCTION", "Sahne, ses, ışık", 420_000, 441_000, local("FIXED", true, true)],
  ["COST", "ARTISTS_SPEAKERS", "Şef ve sanatçı ücretleri", 380_000, 380_000, local("FIXED", false, true)],
  ["COST", "MARKETING", "Dijital reklam ve açık hava", 190_000, 204_300, local("FIXED", false, true)],
  ["COST", "SECURITY", "Güvenlik ve ilk yardım", 165_000, 165_000, local("FIXED", true, true)],
  ["COST", "STAFF", "Saha personeli (günlük)", 140_000, null, local("VARIABLE", true, true)],
  ["COST", "CATERING", "Ücretsiz su ve tadım porsiyonları", 95_000, null, local("VARIABLE", true, false)],
  ["COST", "PERMITS_INSURANCE", "Etkinlik sigortası ve izinler", 48_000, 48_000, local("FIXED", true, true)],
  ["TICKET_ADJUSTMENT", "REFUND", "İptal edilen biletlerin iadesi", null, 10_250],
  ["TICKET_ADJUSTMENT", "DISCOUNT", "Erken kayıt ve öğrenci indirimi", null, 86_000],
]);
await proposeTasks(org, live.eventId, live.core, LIVE_EXTRA_TASKS, false, { // a pending card to demo "apply"
  title: "İkinci gün operasyon görevleri",
  rationale: "Açılış gününde gıda, atık ve yönlendirme akışlarında sorumluluk boşlukları görüldü. Aşağıdaki maddeler ikinci gün operasyon planını tamamlar.",
});
console.log(`  ${LIVE.event.title}: live · 4.820 tickets · ${liveResponses} survey answers · impact run ${run.achievedLevel ?? "insufficient data"}`);

// 2. Upcoming conference: profile and tasks applied; KPI and survey cards waiting for a decision.
const tech = await createFromBlueprint(org, TECH, ["registration"]);
await proposeTasks(org, tech.eventId, tech.core, TECH_TASKS, true);
await proposeKpisAndSurveys(org, tech.eventId, tech.core, [
  { metricKey: "registrations_confirmed", objectiveIndex: 0, target: 3000, targetBasis: "3.000 katılımcı bekleniyor", rationale: "Katılım hedefinin doğrudan göstergesi." },
  { metricKey: "show_up_rate", objectiveIndex: null, target: null, targetBasis: null, rationale: "Ön kayıt yapanların gelme oranı." },
  { metricKey: "overall_satisfaction", objectiveIndex: 0, target: null, targetBasis: null, rationale: "Program kalitesinin genel göstergesi." },
  { metricKey: "session_rating_mean", objectiveIndex: 0, target: null, targetBasis: null, rationale: "Oturumların ayrı ayrı değerlendirilmesi." },
  { metricKey: "leads_per_exhibitor", objectiveIndex: 1, target: null, targetBasis: null, rationale: "Şirketlerin kurduğu temas sayısı iş birliği hedefini ölçer." },
], SURVEY_TEXT, false);
await progressTasks(org, tech.eventId, "early");
console.log(`  ${TECH.event.title}: draft · KPI and survey proposals pending`);

// 3. Completed book fair: everything done, survey closed.
const book = await createFromBlueprint(org, BOOK, ["registration"]);
await proposeTasks(org, book.eventId, book.core, BOOK_TASKS, true);
await proposeKpisAndSurveys(org, book.eventId, book.core, FESTIVAL_KPIS, SURVEY_TEXT, true);
await issueTickets(org, book.eventId, [["Genel", 1500, 1290], ["Öğrenci", 300, 250]], 12, [0.2, 0.1]);
const bookResponses = await collectResponses(org, book.eventId, "ATTENDEE", 230, 4, true);
await setEvent(org, book.eventId, { startDate: addDays(today, -35), endDate: addDays(today, -32) });
await progressTasks(org, book.eventId, "all_done");
await adminDb.execute(sql`update attendees set checked_in_at = checked_in_at - interval '33 days' where organization_id = ${org.organizationId} and event_id = ${book.eventId} and checked_in_at is not null`);
await adminDb.execute(sql`update survey_responses set submitted_at = submitted_at - interval '33 days' where organization_id = ${org.organizationId} and event_id = ${book.eventId}`);
await seedBudget(org, book.eventId, [
  ["INCOME", "TICKETS", "Bilet satışı", 190_000, 178_560, { quantity: 1_488 }],
  ["INCOME", "EXHIBITOR", "Yayınevi stantları (36 stant)", 216_000, 228_000],
  ["INCOME", "SPONSORSHIP", "Kitapçı zinciri sponsorluğu", 120_000, 120_000],
  ["COST", "VENUE", "Fuar salonu kirası", 210_000, 210_000, local("FIXED", true, true)],
  ["COST", "PRODUCTION", "Stant kurulumu ve teknik", 96_000, 104_800, local("FIXED", true, true)],
  ["COST", "ARTISTS_SPEAKERS", "Yazar söyleşileri", 85_000, 78_000, local("FIXED", false, true)],
  ["COST", "MARKETING", "Tanıtım", 60_000, 57_400, local("FIXED", false, true)],
  ["COST", "STAFF", "Karşılama ve bilet personeli", 42_000, 44_100, local("VARIABLE", true, true)],
  ["COST", "SECURITY", "Güvenlik", 38_000, 38_000, local("FIXED", true, true)],
  ["COST", "CATERING", "Yazar ikramları", 14_000, 15_600, local("VARIABLE", true, false)],
  ["TICKET_ADJUSTMENT", "REFUND", "İadeler", null, 1_440],
  ["TICKET_ADJUSTMENT", "DISCOUNT", "Öğrenci indirimi", null, 12_000],
]);
await setEvent(org, book.eventId, { status: "completed" });
console.log(`  ${BOOK.event.title}: completed · ${bookResponses} survey answers`);

// 4. A plain event without a plan proposal.
await adminDb.insert(schema.events).values({
  organizationId: org.organizationId, title: "Kış Sokak Müziği Buluşması", startDate: addDays(today, 55), endDate: addDays(today, 56),
});
console.log("  Kış Sokak Müziği Buluşması: draft, created without a plan proposal");

console.log(`done. Sign in with ${DEMO_EMAIL} (or "Demo Olarak Devam Et" when DEMO_PASSWORD is set).`);
process.exit(0);
