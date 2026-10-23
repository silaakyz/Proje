/**
 * Survey lifecycle and responses (0007).
 *
 *  - open / close (survey.manage): DRAFT → OPEN creates the public link token; OPEN → CLOSED stops
 *    submissions. An opened survey is never rewritten by the AI (apply-proposal keeps it, 0005).
 *  - submissions: anonymously through the public link (token), or typed in by staff (survey.collect,
 *    e.g. paper or interviewer surveys). Both validate against the stored questions of that version
 *    (src/lib/surveys/answers.ts) and store the normalised profile and spend lines the impact engine reads.
 *  - responses are read and excluded (with a reason) by owner/admin only (RLS + survey.manage).
 *
 * No respondent identity is stored. Writes are server-side (adminDb) after the route's permission check
 * (or, for the public link, after the token resolves to an OPEN survey); every query is scoped to the
 * survey's organization.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { eventSurveyLinks, events, surveyQuestions, surveyResponseSpend, surveyResponses, surveys } from "@/db/schema";
import { effectiveRoutes, ROLE_ORDER, ROLE_QUESTION_HELP, ROLE_QUESTION_TEXT, roleQuestionTextSchema, routesSchema } from "@/lib/surveys/roles";
import { AnswerValidationError, normaliseAnswers, type StoredQuestion } from "@/lib/surveys/answers";
import type { UserDbRunner } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";

export const surveyActionSchema = z.object({ organizationId: z.uuid(), action: z.enum(["open", "close"]) });
const answersSchema = z.record(z.string().max(64), z.unknown()).refine((o) => Object.keys(o).length <= 200, "too many answers");
export const publicResponseSchema = z.object({ answers: answersSchema, sensitiveConsent: z.boolean().default(false) });
export const staffResponseSchema = publicResponseSchema.extend({ organizationId: z.uuid() });
export const exclusionSchema = z
  .object({ organizationId: z.uuid(), isExcluded: z.boolean(), reason: z.string().trim().min(3).max(500).optional() })
  .refine((v) => !v.isExcluded || !!v.reason, { message: "a reason is required to exclude a response", path: ["reason"] });

type SurveyRow = { id: string; organizationId: string; eventId: string; audience: (typeof surveys.$inferSelect)["audience"]; version: number; status: string };

async function surveyInOrg(organizationId: string, surveyId: string) {
  const [s] = await adminDb.select().from(surveys).where(and(eq(surveys.id, surveyId), eq(surveys.organizationId, organizationId))).limit(1);
  if (!s) throw new ApiError(404, "Survey not found");
  return s;
}

const questionsOf = (s: Pick<SurveyRow, "id" | "organizationId">) =>
  adminDb
    .select({
      questionKey: surveyQuestions.questionKey, type: surveyQuestions.type, questionText: surveyQuestions.questionText,
      isMandatory: surveyQuestions.isMandatory, isSensitive: surveyQuestions.isSensitive, options: surveyQuestions.options,
      metadata: surveyQuestions.metadata, position: surveyQuestions.position,
    })
    .from(surveyQuestions)
    .where(and(eq(surveyQuestions.surveyId, s.id), eq(surveyQuestions.organizationId, s.organizationId)))
    .orderBy(asc(surveyQuestions.position), asc(surveyQuestions.questionKey));

/** Surveys of an event with question and response counts. The public token only for `includeToken` callers. */
export async function listEventSurveys(organizationId: string, eventId: string, includeToken: boolean) {
  const [ev] = await adminDb.select({ id: events.id }).from(events).where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  const rows = await adminDb
    .select({
      id: surveys.id, audience: surveys.audience, version: surveys.version, status: surveys.status, title: surveys.title,
      targetResponses: surveys.targetResponses, opensAt: surveys.opensAt, closesAt: surveys.closesAt, publicToken: surveys.publicToken,
      // Qualified on purpose: inside a correlated subquery a bare "id" would bind to the inner table.
      questions: sql<number>`(select count(*)::int from survey_questions q where q.survey_id = "surveys"."id")`,
      responses: sql<number>`(select count(*)::int from survey_responses r where r.survey_id = "surveys"."id" and not r.is_excluded)`,
    })
    .from(surveys)
    .where(and(eq(surveys.organizationId, organizationId), eq(surveys.eventId, eventId)))
    .orderBy(asc(surveys.audience), desc(surveys.version));
  return rows.map(({ publicToken, ...r }) => (includeToken ? { ...r, publicToken } : r));
}

// ------------------------------------------------------------------------------------------- one link per event

const newToken = () => randomBytes(32).toString("base64url");
type SurveyRecord = typeof surveys.$inferSelect;

/** The event's single survey link (one QR code); created on first use, idempotent. */
export async function ensureEventSurveyLink(organizationId: string, eventId: string, userId: string | null) {
  await adminDb.insert(eventSurveyLinks).values({ organizationId, eventId, token: newToken(), createdBy: userId }).onConflictDoNothing();
  const [l] = await adminDb.select().from(eventSurveyLinks)
    .where(and(eq(eventSurveyLinks.eventId, eventId), eq(eventSurveyLinks.organizationId, organizationId))).limit(1);
  return l!;
}

/** The latest version of each audience's survey (any status), in the default role order. */
async function latestSurveysOf(organizationId: string, eventId: string) {
  const rows = await adminDb.select().from(surveys)
    .where(and(eq(surveys.organizationId, organizationId), eq(surveys.eventId, eventId)))
    .orderBy(desc(surveys.version));
  const latest = new Map<string, SurveyRecord>();
  const accepting = new Map<string, SurveyRecord>();
  for (const s of rows) {
    if (!latest.has(s.audience)) latest.set(s.audience, s);
    if (isAcceptingNow(s) && !accepting.has(s.audience)) accepting.set(s.audience, s);
  }
  const order = (m: Map<string, SurveyRecord>) => ROLE_ORDER.map((a) => m.get(a)).filter((x): x is SurveyRecord => !!x);
  return { latest: order(latest), accepting: order(accepting) };
}

const storedRoutes = (l: { routes: unknown }) => {
  const r = routesSchema.safeParse(l.routes);
  return r.success ? r.data : null;
};

/**
 * For survey managers: the single link (always created, so the QR code can be printed before the surveys open), the
 * first question and its options, and each audience's survey with its state.
 */
export async function eventSurveyLinkInfo(organizationId: string, eventId: string, userId: string) {
  await listEventSurveys(organizationId, eventId, false); // 404 for another organization's event
  const l = await ensureEventSurveyLink(organizationId, eventId, userId);
  const { latest, accepting } = await latestSurveysOf(organizationId, eventId);
  const counts = await adminDb.select({ surveyId: surveyQuestions.surveyId, n: count() }).from(surveyQuestions)
    .where(and(eq(surveyQuestions.organizationId, organizationId), eq(surveyQuestions.eventId, eventId))).groupBy(surveyQuestions.surveyId);
  const surveyOf = (a: string) => accepting.find((s) => s.audience === a) ?? latest.find((s) => s.audience === a)!;
  const saved = storedRoutes(l);
  return {
    token: l.token,
    roleQuestion: l.roleQuestion ?? ROLE_QUESTION_TEXT,
    customized: !!saved || !!l.roleQuestion,
    routes: effectiveRoutes(saved, latest.map((s) => s.audience)),
    surveys: latest.map((x) => {
      const s = surveyOf(x.audience);
      return {
        audience: s.audience, surveyId: s.id, title: s.title, version: s.version, status: s.status,
        accepting: isAcceptingNow(s), questions: Number(counts.find((c) => c.surveyId === s.id)?.n ?? 0),
      };
    }),
  };
}

export const updateSurveyLinkSchema = z.object({
  organizationId: z.uuid(),
  /** null = back to the default question and options */
  roleQuestion: roleQuestionTextSchema.nullable(),
  routes: routesSchema.nullable(),
});

/** Saves the first question and its options (survey.manage). Options may only open audiences that have a survey. */
export async function updateEventSurveyLink(organizationId: string, eventId: string, userId: string, input: z.infer<typeof updateSurveyLinkSchema>) {
  await listEventSurveys(organizationId, eventId, false);
  await ensureEventSurveyLink(organizationId, eventId, userId);
  const present = new Set((await latestSurveysOf(organizationId, eventId)).latest.map((s) => s.audience));
  const unknown = (input.routes ?? []).flatMap((r) => r.audiences).filter((a) => !present.has(a));
  if (unknown.length) throw new ApiError(422, `Bu etkinlikte anketi olmayan kitle seçildi: ${[...new Set(unknown)].join(", ")}`, "SURVEY_LINK_INVALID");
  await adminDb.update(eventSurveyLinks)
    .set({ roleQuestion: input.roleQuestion, routes: input.routes, updatedAt: sql`now()` })
    .where(and(eq(eventSurveyLinks.eventId, eventId), eq(eventSurveyLinks.organizationId, organizationId)));
  return eventSurveyLinkInfo(organizationId, eventId, userId);
}

/**
 * Opens, for every audience that has no survey accepting answers, its latest DRAFT survey (if it has questions):
 * the single QR code then offers every option. Returns what was opened and what was skipped (with the reason).
 */
export async function openAllEventSurveys(organizationId: string, eventId: string) {
  await listEventSurveys(organizationId, eventId, false);
  const { latest, accepting } = await latestSurveysOf(organizationId, eventId);
  const opened: string[] = [];
  const skipped: { audience: string; reason: string }[] = [];
  for (const s of latest) {
    if (accepting.some((a) => a.audience === s.audience)) continue;
    if (s.status !== "DRAFT") { skipped.push({ audience: s.audience, reason: s.status === "CLOSED" ? "kapalı" : "yanıt dönemi dışında" }); continue; }
    try {
      await setSurveyStatus(organizationId, s.id, "open");
      opened.push(s.audience);
    } catch (e) {
      skipped.push({ audience: s.audience, reason: e instanceof ApiError && e.code === "NO_QUESTIONS" ? "sorusu yok" : "açılamadı" });
    }
  }
  return { opened, skipped };
}

async function linkByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw new ApiError(404, "Survey not found");
  const [l] = await adminDb.select({
    eventId: eventSurveyLinks.eventId, organizationId: eventSurveyLinks.organizationId, title: events.title,
    roleQuestion: eventSurveyLinks.roleQuestion, routes: eventSurveyLinks.routes,
  })
    .from(eventSurveyLinks)
    .innerJoin(events, and(eq(events.id, eventSurveyLinks.eventId), eq(events.organizationId, eventSurveyLinks.organizationId)))
    .where(eq(eventSurveyLinks.token, token)).limit(1);
  if (!l) throw new ApiError(404, "Survey not found");
  return l;
}

/** The options the respondent sees: those with at least one survey accepting answers now (narrowed to those surveys). */
async function publicRoutes(l: Awaited<ReturnType<typeof linkByToken>>) {
  const { latest, accepting } = await latestSurveysOf(l.organizationId, l.eventId);
  const open = new Set(accepting.map((s) => s.audience));
  const routes = effectiveRoutes(storedRoutes(l), latest.map((s) => s.audience))
    .map((r) => ({ ...r, audiences: r.audiences.filter((a) => open.has(a)) }))
    .filter((r) => r.audiences.length > 0);
  return { routes, accepting };
}

/**
 * What a respondent sees behind the single link: the first question (the role) and, per option, which surveys' questions
 * follow. 404 unknown link, 409 SURVEY_NOT_OPEN when no survey accepts responses.
 */
export async function getPublicEventSurvey(token: string) {
  const l = await linkByToken(token);
  const { routes, accepting } = await publicRoutes(l);
  if (!routes.length) throw new ApiError(409, "This survey is not accepting responses", "SURVEY_NOT_OPEN");
  const used = new Set(routes.flatMap((r) => r.audiences));
  const sections = await Promise.all(accepting.filter((s) => used.has(s.audience)).map(async (s) => ({
    audience: s.audience, title: s.title, intro: s.intro, version: s.version,
    questions: (await questionsOf(s)).filter((q) => q.questionKey).map((q) => ({
      key: q.questionKey!, type: q.type, text: q.questionText, required: q.isMandatory, options: q.options ?? undefined,
      isSensitive: q.isSensitive, helpText: q.metadata.helpText, showIf: q.metadata.showIf,
    })),
  })));
  return {
    eventTitle: l.title,
    roleQuestion: {
      text: l.roleQuestion ?? ROLE_QUESTION_TEXT, helpText: ROLE_QUESTION_HELP,
      options: routes.map((r) => ({ value: r.key, label: r.label })),
    },
    routes: routes.map((r) => ({ key: r.key, audiences: r.audiences })),
    sections,
  };
}

export const publicEventResponseSchema = publicResponseSchema.extend({ role: z.string().max(40) });

/**
 * One anonymous response through the single link. The chosen option decides which surveys it belongs to; each of them
 * gets its own response with the answers to its own questions (a shared question's answer goes to every survey that has
 * it). All of them are validated first and stored in one transaction: either every survey gets the answer or none.
 */
export async function submitPublicEventResponse(token: string, input: z.infer<typeof publicEventResponseSchema>) {
  const l = await linkByToken(token);
  const { routes, accepting } = await publicRoutes(l);
  const route = routes.find((r) => r.key === input.role);
  if (!route) {
    const known = effectiveRoutes(storedRoutes(l), ROLE_ORDER).some((r) => r.key === input.role);
    if (known) throw new ApiError(409, "This survey is not accepting responses", "SURVEY_NOT_OPEN");
    throw new ApiError(422, "Invalid answers", "INVALID_ANSWERS", { problems: ["role: unknown"] });
  }
  const targets = route.audiences.map((a) => accepting.find((s) => s.audience === a)!);
  const prepared: { s: SurveyRecord; n: Normalised }[] = [];
  const problems: string[] = [];
  for (const s of targets) {
    const qs = await questionsOf(s);
    const keys = new Set(qs.map((q) => q.questionKey));
    const own = Object.fromEntries(Object.entries(input.answers).filter(([k]) => keys.has(k)));
    try {
      const n = normaliseAnswers(qs as StoredQuestion[], own, { sensitiveConsent: input.sensitiveConsent });
      if (Object.keys(n.answers).length) prepared.push({ s, n });
    } catch (e) {
      if (e instanceof AnswerValidationError) problems.push(...e.problems);
      else throw e;
    }
  }
  if (problems.length) throw new ApiError(422, "Invalid answers", "INVALID_ANSWERS", { problems });
  if (!prepared.length) throw new ApiError(422, "Empty response", "INVALID_ANSWERS", { problems: ["no answers"] });
  const submittedAt = await adminDb.transaction(async (tx) => {
    let at: Date | null = null;
    for (const { s, n } of prepared) at = (await insertResponse(tx, s, n, "PUBLIC_LINK", null)).submittedAt;
    return at!;
  });
  return { submittedAt };
}

/**
 * One survey with its questions for members (org.read): what staff need to type in a paper or interviewer
 * response. The public link token only for `includeToken` callers (survey.manage).
 */
export async function getSurveyDetail(organizationId: string, surveyId: string, includeToken: boolean) {
  const s = await surveyInOrg(organizationId, surveyId);
  const qs = await questionsOf(s);
  const [{ n } = { n: 0 }] = await adminDb.select({ n: count() }).from(surveyResponses)
    .where(and(eq(surveyResponses.surveyId, s.id), eq(surveyResponses.organizationId, organizationId), eq(surveyResponses.isExcluded, false)));
  return {
    id: s.id, eventId: s.eventId, audience: s.audience, version: s.version, status: s.status, title: s.title, intro: s.intro,
    targetResponses: s.targetResponses, opensAt: s.opensAt, closesAt: s.closesAt, acceptingResponses: isAcceptingNow(s),
    responses: Number(n),
    ...(includeToken ? { publicToken: s.publicToken } : {}),
    questions: qs.filter((q) => q.questionKey).map((q) => ({
      key: q.questionKey, type: q.type, text: q.questionText, required: q.isMandatory, options: q.options ?? undefined,
      isSensitive: q.isSensitive, helpText: q.metadata.helpText, showIf: q.metadata.showIf, spendCategory: q.metadata.spendCategory,
    })),
  };
}

export async function setSurveyStatus(organizationId: string, surveyId: string, action: "open" | "close") {
  const s = await surveyInOrg(organizationId, surveyId);
  if (action === "open") {
    if (s.status !== "DRAFT") throw new ApiError(409, `Only a DRAFT survey can be opened (status ${s.status})`, "INVALID_TRANSITION");
    const [{ n } = { n: 0 }] = await adminDb.select({ n: count() }).from(surveyQuestions).where(eq(surveyQuestions.surveyId, s.id));
    if (Number(n) === 0) throw new ApiError(422, "A survey without questions cannot be opened", "NO_QUESTIONS");
    const [row] = await adminDb.update(surveys)
      .set({ status: "OPEN", publicToken: s.publicToken ?? randomBytes(32).toString("base64url"), opensAt: s.opensAt ?? sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(surveys.id, s.id), eq(surveys.organizationId, organizationId), eq(surveys.status, "DRAFT")))
      .returning({ id: surveys.id, status: surveys.status, publicToken: surveys.publicToken, opensAt: surveys.opensAt });
    if (!row) throw new ApiError(409, "The survey changed meanwhile", "INVALID_TRANSITION");
    // the event's single link (all open surveys, role first) exists as soon as one survey is open
    await ensureEventSurveyLink(organizationId, s.eventId, null);
    return row;
  }
  if (s.status !== "OPEN") throw new ApiError(409, `Only an OPEN survey can be closed (status ${s.status})`, "INVALID_TRANSITION");
  const [row] = await adminDb.update(surveys)
    .set({ status: "CLOSED", closesAt: sql`greatest(now(), coalesce(${surveys.opensAt}, now()) + interval '1 second')`, updatedAt: sql`now()` })
    .where(and(eq(surveys.id, s.id), eq(surveys.organizationId, organizationId), eq(surveys.status, "OPEN")))
    .returning({ id: surveys.id, status: surveys.status, closesAt: surveys.closesAt });
  if (!row) throw new ApiError(409, "The survey changed meanwhile", "INVALID_TRANSITION");
  return row;
}

const isAcceptingNow = (s: { status: string; opensAt: Date | null; closesAt: Date | null }) => {
  const now = Date.now();
  return s.status === "OPEN" && (!s.opensAt || s.opensAt.getTime() <= now) && (!s.closesAt || s.closesAt.getTime() > now);
};

/** What a respondent sees behind the public link. 404 for unknown tokens, 409 when not accepting. */
export async function getPublicSurvey(token: string) {
  const s = await surveyByToken(token);
  const qs = await questionsOf(s);
  return {
    title: s.title, intro: s.intro, audience: s.audience, version: s.version,
    questions: qs.filter((q) => q.questionKey).map((q) => ({
      key: q.questionKey, type: q.type, text: q.questionText, required: q.isMandatory, options: q.options ?? undefined,
      isSensitive: q.isSensitive, helpText: q.metadata.helpText, showIf: q.metadata.showIf,
    })),
  };
}

async function surveyByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw new ApiError(404, "Survey not found");
  const [s] = await adminDb.select().from(surveys).where(eq(surveys.publicToken, token)).limit(1);
  if (!s) throw new ApiError(404, "Survey not found");
  if (!isAcceptingNow(s)) throw new ApiError(409, "This survey is not accepting responses", "SURVEY_NOT_OPEN");
  return s;
}

type Normalised = ReturnType<typeof normaliseAnswers>;
type Tx = Parameters<Parameters<typeof adminDb.transaction>[0]>[0];

async function insertResponse(tx: Tx, s: SurveyRow, n: Normalised, channel: "PUBLIC_LINK" | "STAFF_ENTRY", enteredBy: string | null) {
  const [r] = await tx.insert(surveyResponses).values({
    organizationId: s.organizationId, eventId: s.eventId, surveyId: s.id, audience: s.audience, surveyVersion: s.version,
    channel, enteredBy, answers: n.answers, isLocalResident: n.isLocalResident, homeProvinceCode: n.homeProvinceCode,
    partySize: n.partySize, daysPresent: n.daysPresent, nightsStayed: n.nightsStayed, mainReason: n.mainReason,
    wouldVisitAnyway: n.wouldVisitAnyway,
  }).returning({ id: surveyResponses.id, submittedAt: surveyResponses.submittedAt });
  const spend = Object.entries(n.spendKurus).map(([category, amountKurus]) => ({
    responseId: r!.id, organizationId: s.organizationId, category: category as (typeof surveyResponseSpend.$inferInsert)["category"], amountKurus: amountKurus!,
  }));
  if (spend.length) await tx.insert(surveyResponseSpend).values(spend);
  return { id: r!.id, submittedAt: r!.submittedAt };
}

async function storeResponse(
  s: SurveyRow,
  answers: Record<string, unknown>,
  sensitiveConsent: boolean,
  channel: "PUBLIC_LINK" | "STAFF_ENTRY",
  enteredBy: string | null,
) {
  const qs = await questionsOf(s);
  let n;
  try {
    n = normaliseAnswers(qs as StoredQuestion[], answers, { sensitiveConsent });
  } catch (e) {
    if (e instanceof AnswerValidationError) throw new ApiError(422, "Invalid answers", "INVALID_ANSWERS", { problems: e.problems });
    throw e;
  }
  if (Object.keys(n.answers).length === 0) throw new ApiError(422, "Empty response", "INVALID_ANSWERS", { problems: ["no answers"] });
  return adminDb.transaction((tx) => insertResponse(tx, s, n, channel, enteredBy));
}

export async function submitPublicResponse(token: string, input: z.infer<typeof publicResponseSchema>) {
  const s = await surveyByToken(token);
  const r = await storeResponse(s, input.answers, input.sensitiveConsent, "PUBLIC_LINK", null);
  return { submittedAt: r.submittedAt }; // the respondent gets no id: nothing to look up or change later
}

export async function submitStaffResponse(organizationId: string, surveyId: string, userId: string, input: z.infer<typeof staffResponseSchema>) {
  const s = await surveyInOrg(organizationId, surveyId);
  if (!isAcceptingNow(s)) throw new ApiError(409, "This survey is not accepting responses", "SURVEY_NOT_OPEN");
  return storeResponse(s, input.answers, input.sensitiveConsent, "STAFF_ENTRY", userId);
}

/** Owner/admin list under RLS (survey_responses SELECT policy). */
export async function listResponses(runAsUser: UserDbRunner, organizationId: string, surveyId: string) {
  await surveyInOrg(organizationId, surveyId);
  return runAsUser(async (tx) => {
    const rows = await tx
      .select({
        id: surveyResponses.id, surveyVersion: surveyResponses.surveyVersion, channel: surveyResponses.channel, answers: surveyResponses.answers,
        isLocalResident: surveyResponses.isLocalResident, homeProvinceCode: surveyResponses.homeProvinceCode, partySize: surveyResponses.partySize,
        daysPresent: surveyResponses.daysPresent, nightsStayed: surveyResponses.nightsStayed, wouldVisitAnyway: surveyResponses.wouldVisitAnyway,
        isExcluded: surveyResponses.isExcluded, exclusionReason: surveyResponses.exclusionReason, submittedAt: surveyResponses.submittedAt,
      })
      .from(surveyResponses)
      .where(and(eq(surveyResponses.organizationId, organizationId), eq(surveyResponses.surveyId, surveyId)))
      .orderBy(asc(surveyResponses.submittedAt), asc(surveyResponses.id))
      .limit(5000);
    const spend = await tx.select().from(surveyResponseSpend)
      .innerJoin(surveyResponses, and(eq(surveyResponses.id, surveyResponseSpend.responseId), eq(surveyResponses.surveyId, surveyId)))
      .where(eq(surveyResponseSpend.organizationId, organizationId));
    const byResponse = new Map<string, Record<string, number>>();
    for (const { survey_response_spend: x } of spend) (byResponse.get(x.responseId) ?? byResponse.set(x.responseId, {}).get(x.responseId)!)[x.category] = x.amountKurus;
    return rows.map((r) => ({ ...r, spendKurus: byResponse.get(r.id) ?? {} }));
  });
}

export async function setResponseExclusion(organizationId: string, responseId: string, userId: string, input: z.infer<typeof exclusionSchema>) {
  const [row] = await adminDb.update(surveyResponses)
    .set(input.isExcluded
      ? { isExcluded: true, exclusionReason: input.reason!, excludedBy: userId, excludedAt: sql`now()` }
      : { isExcluded: false, exclusionReason: null, excludedBy: null, excludedAt: null })
    .where(and(eq(surveyResponses.id, responseId), eq(surveyResponses.organizationId, organizationId)))
    .returning({ id: surveyResponses.id, isExcluded: surveyResponses.isExcluded, exclusionReason: surveyResponses.exclusionReason });
  if (!row) throw new ApiError(404, "Response not found");
  return row;
}
