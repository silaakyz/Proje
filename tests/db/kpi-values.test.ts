/**
 * KPI values on a real migrated database (src/server/analytics/kpi-service.ts): the SQL aggregates (tickets,
 * lead time, tasks on time) and survey loading feed the engine as intended. `@/db` is mocked so adminDb is PGlite.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { attendees, eventKpis, events, surveyResponses, surveyResponseSpend, surveys, tasks } from "@/db/schema";
import { ORG_A, ORG_B, setupDb } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => {
  class UnauthenticatedError extends Error {}
  return {
    UnauthenticatedError,
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});

const svc = await import("@/server/analytics/kpi-service");
const kpiSvc = await import("@/server/planning/kpi-service");
const { ApiError } = await import("@/server/http");

let ctx: Awaited<ReturnType<typeof setupDb>>;
let eventId: string;
const value = (vals: { id: string; value: number | null }[], id: string) => vals.find((x) => x.id === id)?.value;

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  const [ev] = await ctx.db.insert(events).values({ organizationId: ORG_A, title: "KPI", status: "completed", startDate: "2026-06-10", endDate: "2026-06-11" }).returning();
  eventId = ev!.id;
  // 4 valid tickets (3 checked in), 1 cancelled; issued 10 days before the start (Istanbul date)
  const issued = new Date("2026-05-31T09:00:00Z");
  await ctx.db.insert(attendees).values([
    ...[true, true, true, false].map((c) => ({ organizationId: ORG_A, eventId, ticketType: "Genel", isCheckedIn: c, checkedInAt: c ? new Date() : null, createdAt: issued })),
    { organizationId: ORG_A, eventId, ticketType: "Genel", cancelledAt: new Date(), createdAt: issued },
  ]);
  await ctx.db.insert(tasks).values([
    { organizationId: ORG_A, eventId, title: "a", dueDate: "2026-06-01", status: "DONE", completedAt: new Date("2026-05-30T10:00:00Z") },
    { organizationId: ORG_A, eventId, title: "b", dueDate: "2026-06-01", status: "DONE", completedAt: new Date("2026-06-05T10:00:00Z") },
    { organizationId: ORG_A, eventId, title: "c", dueDate: "2026-06-01", status: "TODO" },
    { organizationId: ORG_A, eventId, title: "d", dueDate: "2099-01-01", status: "TODO" },
  ]);
  const [sv] = await ctx.db.insert(surveys).values({ organizationId: ORG_A, eventId, audience: "ATTENDEE", title: "Ziyaretçi" }).returning();
  const base = { organizationId: ORG_A, eventId, surveyId: sv!.id, audience: "ATTENDEE" as const, surveyVersion: 1, channel: "PUBLIC_LINK" as const };
  const [r1] = await ctx.db.insert(surveyResponses).values({ ...base, answers: { q_nps: 10, q_overall_satisfaction: 5 }, isLocalResident: false, partySize: 2,
    daysPresent: 2, nightsStayed: 1, mainReason: "event", wouldVisitAnyway: "no" }).returning();
  await ctx.db.insert(surveyResponses).values({ ...base, answers: { q_nps: 3, q_overall_satisfaction: 2 }, isLocalResident: true });
  await ctx.db.insert(surveyResponses).values({ ...base, answers: { q_nps: 0 }, isLocalResident: true, isExcluded: true, exclusionReason: "test" });
  await ctx.db.insert(surveyResponseSpend).values([
    { organizationId: ORG_A, responseId: r1!.id, category: "FOOD_BEVERAGE", amountKurus: 100_000 },
    { organizationId: ORG_A, responseId: r1!.id, category: "INTERCITY_TRANSPORT", amountKurus: 500_000 },
  ]);
  await ctx.db.insert(eventKpis).values([
    { organizationId: ORG_A, eventId, metricName: "show_up_rate", dataSource: "ticket_sales", status: "ACTIVE" },
    { organizationId: ORG_A, eventId, metricName: "b2b_meetings_completed", dataSource: "system", status: "ACTIVE" },
  ]);
});

describe("event KPI values", () => {
  it("aggregates tickets, lead time, tasks and non-excluded survey answers", async () => {
    const { values } = await svc.eventKpiValues(ORG_A, eventId, { finance: true });
    expect(value(values, "registered_count")).toBe(4);
    expect(value(values, "cancellation_rate")).toBe(20);
    expect(value(values, "attendance_rate")).toBe(75);
    expect(value(values, "registration_lead_time_avg_days")).toBe(10);
    expect(value(values, "task_on_time_rate")).toBeCloseTo(100 / 3, 6); // 3 due, 1 done in time
    expect(value(values, "nps")).toBe(0); // one promoter, one detractor; the excluded answer does not count
    expect(value(values, "nonlocal_share")).toBe(50);
    expect(value(values, "spend_per_visitor")).toBe(500); // 1000 TL food ÷ 2, intercity transport left out
    expect(value(values, "gross_visitor_spend")).toBe(3 * 0.5 * 500);
    expect(value(values, "attributable_fraction")).toBe(100);
  });

  it("is scoped to the organization", async () => {
    await expect(svc.eventKpiValues(ORG_B, eventId, { finance: true })).rejects.toBeInstanceOf(ApiError);
  });

  it("event KPIs: engine value for computed metrics, manual entry only for the others", async () => {
    const actuals = await svc.eventKpiActuals(ORG_A, eventId, { finance: true });
    expect(actuals.find((a) => a.metricName === "show_up_rate")).toMatchObject({ catalogId: "attendance_rate", actual: 75, actualSource: "engine" });
    const press = actuals.find((a) => a.metricName === "b2b_meetings_completed")!;
    expect(press).toMatchObject({ actual: null, computed: null });
    const show = actuals.find((a) => a.metricName === "show_up_rate")!;
    await expect(kpiSvc.updateKpi(show.id, { organizationId: ORG_A, actualValue: 99 })).rejects.toMatchObject({ code: "KPI_COMPUTED" });
    await kpiSvc.updateKpi(press.id, { organizationId: ORG_A, actualValue: 12 });
    expect((await svc.eventKpiActuals(ORG_A, eventId, { finance: true })).find((a) => a.metricName === "b2b_meetings_completed")).toMatchObject({ actual: 12, actualSource: "manual" });
  });

  it("an external metric takes a manual actual while no source delivers it; a verified clipping then wins", async () => {
    const { eventKpis: ek, mediaMentions } = await import("@/db/schema");
    const [k] = await ctx.db.insert(ek).values({ organizationId: ORG_A, eventId, metricName: "press_mentions", dataSource: "system", status: "ACTIVE" }).returning();
    await kpiSvc.updateKpi(k!.id, { organizationId: ORG_A, actualValue: 7 });
    expect((await svc.eventKpiActuals(ORG_A, eventId, { finance: true })).find((a) => a.id === k!.id)).toMatchObject({ actual: 7, actualSource: "manual" });
    await ctx.db.insert(mediaMentions).values({ organizationId: ORG_A, eventId, url: "https://gazete.example/a", foundBy: "MANUAL", status: "VERIFIED", reviewedAt: new Date() });
    expect((await svc.eventKpiActuals(ORG_A, eventId, { finance: true })).find((a) => a.id === k!.id)).toMatchObject({ actual: 1, actualSource: "engine" });
  });
});
