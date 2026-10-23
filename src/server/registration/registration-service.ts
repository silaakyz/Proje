/**
 * The public, KVKK-compliant registration form of an event (0018).
 *
 *  - The organizer (attendee.write) sets it up: ticket type, capacity, open/close times, optional phone field, the
 *    privacy notice (aydınlatma metni; a change raises its version) and the optional explicit-consent text.
 *  - A person registers through /kayit/<token>: a ticket (attendee) is issued and a registration row keeps the personal
 *    data with the proof of the notice (version, sha256, time) and of the optional consent (its exact text, time).
 *    The ticket link is shown and, with e-mail configured, e-mailed.
 *  - Personal data is deleted on request (attendee.write) or automatically `retention_days` after the event ends
 *    (purgeExpiredRegistrations, run by the background scheduler); the ticket stays as an anonymous count.
 * Server-side writes only (adminDb after the permission check or the public token); every query is organization-scoped.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { adminDb } from "@/db";
import { attendees, eventRegistrationForms, eventRegistrations, events, organizations } from "@/db/schema";
import { defaultMarketingConsentText, defaultPrivacyNotice, type registrationFormSchema, type registrationSubmitSchema } from "@/lib/registration/notice";
import { appBaseUrl, emailAvailable, EmailError, sendMail, ticketMail } from "@/server/email/mailer";
import { ApiError } from "@/server/http";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const isUnique = (e: unknown) => { const x = e as { code?: string; cause?: { code?: string } }; return x?.code === "23505" || x?.cause?.code === "23505"; };

async function eventOf(organizationId: string, eventId: string) {
  const [ev] = await adminDb.select({ id: events.id, title: events.title, status: events.status, startDate: events.startDate, endDate: events.endDate, aiConfig: events.aiConfig, orgName: organizations.name })
    .from(events).innerJoin(organizations, eq(organizations.id, events.organizationId))
    .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  return ev;
}

/** The event's form (created disabled, with the default notice, on first use). */
async function ensureForm(organizationId: string, eventId: string, userId: string | null) {
  const ev = await eventOf(organizationId, eventId);
  await adminDb.insert(eventRegistrationForms).values({
    organizationId, eventId, token: randomBytes(32).toString("base64url"), updatedBy: userId,
    privacyNotice: defaultPrivacyNotice({ organization: ev.orgName, event: ev.title, retentionDays: 90, collectPhone: false }),
    marketingConsentText: defaultMarketingConsentText(ev.orgName),
  }).onConflictDoNothing();
  const [f] = await adminDb.select().from(eventRegistrationForms)
    .where(and(eq(eventRegistrationForms.eventId, eventId), eq(eventRegistrationForms.organizationId, organizationId))).limit(1);
  return { form: f!, event: ev };
}

const registeredCount = async (organizationId: string, eventId: string) =>
  Number((await adminDb.select({ n: count() }).from(eventRegistrations)
    .where(and(eq(eventRegistrations.organizationId, organizationId), eq(eventRegistrations.eventId, eventId))))[0]?.n ?? 0);

type Form = typeof eventRegistrationForms.$inferSelect;
type Ev = Awaited<ReturnType<typeof eventOf>>;

/** open | not_enabled | not_yet | closed | full | event_over */
function stateOf(f: Form, ev: Ev, registered: number) {
  const now = Date.now();
  if (!f.enabled) return "not_enabled" as const;
  if (ev.status === "completed") return "event_over" as const;
  const last = ev.endDate ?? ev.startDate;
  if (last && new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date()) > last) return "event_over" as const;
  if (f.opensAt && f.opensAt.getTime() > now) return "not_yet" as const;
  if (f.closesAt && f.closesAt.getTime() <= now) return "closed" as const;
  if (f.capacity !== null && registered >= f.capacity) return "full" as const;
  return "open" as const;
}

// ------------------------------------------------------------------------------------------- organizer

export async function getRegistrationForm(organizationId: string, eventId: string, userId: string) {
  const { form, event } = await ensureForm(organizationId, eventId, userId);
  const registered = await registeredCount(organizationId, eventId);
  return {
    token: form.token, enabled: form.enabled, ticketType: form.ticketType, capacity: form.capacity,
    opensAt: form.opensAt, closesAt: form.closesAt, collectPhone: form.collectPhone, privacyNotice: form.privacyNotice,
    noticeVersion: form.noticeVersion, marketingConsentText: form.marketingConsentText, retentionDays: form.retentionDays,
    registered, state: stateOf(form, event, registered),
    defaults: {
      privacyNotice: defaultPrivacyNotice({ organization: event.orgName, event: event.title, retentionDays: form.retentionDays, collectPhone: form.collectPhone }),
      marketingConsentText: defaultMarketingConsentText(event.orgName),
    },
  };
}

export async function updateRegistrationForm(organizationId: string, eventId: string, userId: string, input: z.infer<typeof registrationFormSchema>) {
  const { form } = await ensureForm(organizationId, eventId, userId);
  const textChanged = form.privacyNotice.trim() !== input.privacyNotice.trim() || (form.marketingConsentText ?? null) !== (input.marketingConsentText ?? null);
  await adminDb.update(eventRegistrationForms).set({
    enabled: input.enabled, ticketType: input.ticketType, capacity: input.capacity,
    opensAt: input.opensAt ? new Date(input.opensAt) : null, closesAt: input.closesAt ? new Date(input.closesAt) : null,
    collectPhone: input.collectPhone, privacyNotice: input.privacyNotice, marketingConsentText: input.marketingConsentText,
    retentionDays: input.retentionDays, noticeVersion: textChanged ? form.noticeVersion + 1 : form.noticeVersion,
    updatedBy: userId, updatedAt: sql`now()`,
  }).where(and(eq(eventRegistrationForms.eventId, eventId), eq(eventRegistrationForms.organizationId, organizationId)));
  return getRegistrationForm(organizationId, eventId, userId);
}

export async function listRegistrations(organizationId: string, eventId: string) {
  await eventOf(organizationId, eventId);
  return adminDb.select({
    id: eventRegistrations.id, fullName: eventRegistrations.fullName, email: eventRegistrations.email, phone: eventRegistrations.phone,
    noticeVersion: eventRegistrations.noticeVersion, noticeAcceptedAt: eventRegistrations.noticeAcceptedAt,
    marketingConsent: eventRegistrations.marketingConsent, marketingConsentAt: eventRegistrations.marketingConsentAt,
    createdAt: eventRegistrations.createdAt, ticketType: attendees.ticketType, isCheckedIn: attendees.isCheckedIn, cancelledAt: attendees.cancelledAt,
  }).from(eventRegistrations).innerJoin(attendees, eq(attendees.id, eventRegistrations.attendeeId))
    .where(and(eq(eventRegistrations.organizationId, organizationId), eq(eventRegistrations.eventId, eventId)))
    .orderBy(asc(eventRegistrations.createdAt)).limit(10_000);
}

/** Deletes one person's personal data (right to erasure). The ticket stays, anonymous. */
export async function deleteRegistration(organizationId: string, registrationId: string) {
  const [r] = await adminDb.delete(eventRegistrations)
    .where(and(eq(eventRegistrations.id, registrationId), eq(eventRegistrations.organizationId, organizationId))).returning({ id: eventRegistrations.id });
  if (!r) throw new ApiError(404, "Registration not found");
}

/** Deletes the personal data of every registration whose event ended more than its form's retention_days ago. */
export async function purgeExpiredRegistrations() {
  const res = await adminDb.execute(sql`
    delete from event_registrations r using event_registration_forms f, events e
    where f.event_id = r.event_id and f.organization_id = r.organization_id and e.id = r.event_id and e.organization_id = r.organization_id
      and coalesce(e.end_date, e.start_date) is not null
      and (now() at time zone 'Europe/Istanbul')::date > coalesce(e.end_date, e.start_date) + f.retention_days`);
  return (res as unknown as { count?: number; rowCount?: number }).count ?? (res as unknown as { rowCount?: number }).rowCount ?? 0;
}

// ------------------------------------------------------------------------------------------- public

async function formByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw new ApiError(404, "Registration form not found");
  const [f] = await adminDb.select().from(eventRegistrationForms).where(eq(eventRegistrationForms.token, token)).limit(1);
  if (!f) throw new ApiError(404, "Registration form not found");
  const ev = await eventOf(f.organizationId, f.eventId);
  return { f, ev };
}

export async function getPublicRegistrationForm(token: string) {
  const { f, ev } = await formByToken(token);
  if (!f.enabled) throw new ApiError(404, "Registration form not found");
  const state = stateOf(f, ev, await registeredCount(f.organizationId, f.eventId));
  const city = (ev.aiConfig as { event?: { city?: unknown } } | null)?.event?.city;
  return {
    eventTitle: ev.title, organization: ev.orgName, startDate: ev.startDate, endDate: ev.endDate, city: typeof city === "string" ? city : null,
    ticketType: f.ticketType, collectPhone: f.collectPhone, privacyNotice: f.privacyNotice, noticeVersion: f.noticeVersion,
    marketingConsentText: f.marketingConsentText, state, opensAt: f.opensAt, closesAt: f.closesAt,
  };
}

const STATE_ERROR: Record<string, [number, string, string]> = {
  not_enabled: [404, "Registration form not found", "REGISTRATION_NOT_FOUND"],
  not_yet: [409, "Registration has not opened yet", "REGISTRATION_NOT_OPEN"],
  closed: [409, "Registration is closed", "REGISTRATION_CLOSED"],
  event_over: [409, "Registration is closed", "REGISTRATION_CLOSED"],
  full: [409, "The event is full", "REGISTRATION_FULL"],
};

export async function submitRegistration(request: Request, token: string, input: z.infer<typeof registrationSubmitSchema>) {
  const { f: form0, ev } = await formByToken(token);
  if (input.noticeVersion !== form0.noticeVersion) throw new ApiError(409, "The privacy notice has changed", "NOTICE_CHANGED");
  if (input.phone && !form0.collectPhone) input = { ...input, phone: null };
  if (input.marketingConsent && !form0.marketingConsentText) input = { ...input, marketingConsent: false };
  const email = input.email.trim().toLowerCase();
  let created: { attendeeId: string; qrToken: string; ticketType: string };
  try {
    created = await adminDb.transaction(async (tx) => {
      // lock the form: capacity and versions are checked against what is committed
      const [f] = await tx.select().from(eventRegistrationForms).where(eq(eventRegistrationForms.eventId, form0.eventId)).for("update");
      const registered = Number((await tx.select({ n: count() }).from(eventRegistrations).where(eq(eventRegistrations.eventId, f!.eventId)))[0]?.n ?? 0);
      const state = stateOf(f!, ev, registered);
      if (state !== "open") { const [s, m, c] = STATE_ERROR[state]!; throw new ApiError(s, m, c); }
      if (input.noticeVersion !== f!.noticeVersion) throw new ApiError(409, "The privacy notice has changed", "NOTICE_CHANGED");
      const [a] = await tx.insert(attendees).values({ organizationId: f!.organizationId, eventId: f!.eventId, ticketType: f!.ticketType })
        .returning({ id: attendees.id, qr: attendees.qrUuid, ticketType: attendees.ticketType });
      const now = new Date();
      await tx.insert(eventRegistrations).values({
        organizationId: f!.organizationId, eventId: f!.eventId, attendeeId: a!.id, fullName: input.fullName.trim(), email, phone: input.phone,
        noticeVersion: f!.noticeVersion, noticeHash: sha(f!.privacyNotice), noticeAcceptedAt: now,
        marketingConsent: input.marketingConsent, marketingConsentText: input.marketingConsent ? f!.marketingConsentText : null,
        marketingConsentAt: input.marketingConsent ? now : null,
      });
      return { attendeeId: a!.id, qrToken: a!.qr, ticketType: a!.ticketType };
    });
  } catch (e) {
    if (isUnique(e)) throw new ApiError(409, "This address is already registered", "ALREADY_REGISTERED");
    throw e;
  }
  let emailed = false;
  if (emailAvailable(request)) {
    try {
      await sendMail(ticketMail({
        to: email, name: input.fullName.trim(), event: ev.title, organization: ev.orgName, ticketType: created.ticketType,
        startDate: ev.startDate, url: `${appBaseUrl(request)}/bilet/${created.qrToken}`,
      }));
      emailed = true;
    } catch (e) {
      console.warn(`[email] bilet e-postası gönderilemedi: ${e instanceof EmailError ? e.message : "bilinmeyen hata"}`);
    }
  }
  return { qrToken: created.qrToken, ticketType: created.ticketType, emailed };
}

/** What a ticket link shows (the holder of the link holds the ticket). */
export async function getPublicTicket(qrToken: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qrToken)) throw new ApiError(404, "Ticket not found");
  const [t] = await adminDb.select({
    attendeeId: attendees.id, ticketType: attendees.ticketType, isCheckedIn: attendees.isCheckedIn, cancelledAt: attendees.cancelledAt,
    eventTitle: events.title, startDate: events.startDate, endDate: events.endDate, fullName: eventRegistrations.fullName,
  }).from(attendees)
    .innerJoin(events, and(eq(events.id, attendees.eventId), eq(events.organizationId, attendees.organizationId)))
    .leftJoin(eventRegistrations, eq(eventRegistrations.attendeeId, attendees.id))
    .where(eq(attendees.qrUuid, qrToken)).limit(1);
  if (!t) throw new ApiError(404, "Ticket not found");
  return { ...t, cancelled: !!t.cancelledAt, cancelledAt: undefined };
}
