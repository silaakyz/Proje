import { describe, expect, it } from "vitest";
import { KPI_CATALOG, KPI_BY_ID, LIBRARY_TO_CATALOG } from "../catalog";
import { computeKpis, type FinanceLine, type KpiDataset, type KpiResponse } from "../engine";

const r = (o: Partial<KpiResponse>): KpiResponse => ({
  weight: 1, isLocalResident: null, homeProvinceCode: null, partySize: null, daysPresent: null, nightsStayed: null, mainReason: null,
  wouldVisitAnyway: null, nps: null, overallSatisfaction: null, accessibilitySatisfaction: null, attendedBefore: null, spendKurus: {}, ...o,
});
const base = (o: Partial<KpiDataset> = {}): KpiDataset => ({
  tickets: { valid: 0, cancelled: 0, checkedIn: 0, leadDaysSum: 0, leadDaysN: 0 }, capacity: null, eventFinished: true,
  tasks: { dueReached: 0, onTime: 0 }, responses: [], finance: null, ...o,
});
const val = (m: Map<string, { value: number | null }>, id: string) => m.get(id)!.value;

describe("catalog", () => {
  it("has unique ids, every computable id is produced by the engine, library keys map to catalog ids", () => {
    const ids = KPI_CATALOG.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    const produced = computeKpis(base());
    for (const k of KPI_CATALOG.filter((x) => x.computable)) expect(produced.has(k.id), k.id).toBe(true);
    for (const id of produced.keys()) expect(KPI_BY_ID.get(id)?.computable, id).toBe(true);
    for (const id of Object.values(LIBRARY_TO_CATALOG)) expect(KPI_BY_ID.has(id), id).toBe(true);
    for (const k of KPI_CATALOG) if (k.evidence.includes("K")) expect(k.refs?.length, k.id).toBeGreaterThan(0);
  });
});

describe("ratios and attendance", () => {
  it("follows the document's formulas; denominator 0 → null", () => {
    const m = computeKpis(base({ tickets: { valid: 200, cancelled: 50, checkedIn: 150, leadDaysSum: 2000, leadDaysN: 200 }, capacity: 300,
      tasks: { dueReached: 8, onTime: 6 } }));
    expect(val(m, "registered_count")).toBe(200);
    expect(val(m, "cancellation_rate")).toBe(20); // 50 / 250
    expect(val(m, "attendance_rate")).toBe(75);
    expect(val(m, "no_show_rate")).toBe(25);
    expect(val(m, "capacity_utilization")).toBe(50);
    expect(val(m, "registration_lead_time_avg_days")).toBe(10);
    expect(val(m, "task_on_time_rate")).toBe(75);
    const empty = computeKpis(base());
    expect(empty.get("attendance_rate")).toMatchObject({ value: null });
    expect(empty.get("task_on_time_rate")).toMatchObject({ value: null });
    expect(empty.get("capacity_utilization")).toMatchObject({ value: null, reason: "no_data" });
  });
});

describe("survey metrics", () => {
  it("NPS, shares and the 95% interval with weights", () => {
    // weights: promoters 2+1, passive 1, detractor 1 → p = 3/5, d = 1/5
    const m = computeKpis(base({ responses: [r({ nps: 10, weight: 2 }), r({ nps: 9 }), r({ nps: 8 }), r({ nps: 3 })] }));
    expect(val(m, "nps")).toBeCloseTo(40, 10);
    expect(val(m, "promoter_share")).toBeCloseTo(60, 10);
    expect(val(m, "detractor_share")).toBeCloseTo(20, 10);
    const half = 1.96 * 100 * Math.sqrt((0.6 + 0.2 - 0.4 ** 2) / 4);
    expect(val(m, "nps_ci95")).toBeCloseTo(half, 10);
    expect(m.get("nps_ci95")!.interval![0]).toBeCloseTo(40 - half, 10);
  });

  it("satisfaction mean and CSAT (top-2 box)", () => {
    const m = computeKpis(base({ responses: [r({ overallSatisfaction: 5 }), r({ overallSatisfaction: 4 }), r({ overallSatisfaction: 2, weight: 2 })] }));
    expect(val(m, "overall_satisfaction")).toBeCloseTo(13 / 4, 10);
    expect(val(m, "csat")).toBeCloseTo(50, 10);
  });

  it("visitor spend: per person, non-residents, local categories only; extrapolated to check-ins", () => {
    const a = r({ isLocalResident: false, partySize: 2, daysPresent: 2, nightsStayed: 2, mainReason: "event", wouldVisitAnyway: "no",
      spendKurus: { ACCOMMODATION: 200_000, FOOD_BEVERAGE: 100_000, INTERCITY_TRANSPORT: 999_900 } }); // 3000 TL party → 1500 pp
    const b = r({ isLocalResident: false, partySize: 1, daysPresent: 1, nightsStayed: 0, mainReason: "other", wouldVisitAnyway: "yes",
      spendKurus: { FOOD_BEVERAGE: 50_000 } }); // 500 pp
    const c = r({ isLocalResident: true });
    const m = computeKpis(base({ tickets: { valid: 100, cancelled: 0, checkedIn: 90, leadDaysSum: 0, leadDaysN: 0 }, responses: [a, b, c] }));
    expect(val(m, "nonlocal_share")).toBeCloseTo(200 / 3, 10);
    expect(val(m, "spend_per_visitor")).toBe(1000);
    expect(val(m, "accommodation_spend_per_visitor")).toBe(500);
    expect(val(m, "avg_daily_spend")).toBe((750 + 500) / 2);
    expect(val(m, "accommodation_use_rate")).toBe(50);
    expect(val(m, "avg_nights_stayed")).toBe(2);
    expect(val(m, "event_primary_purpose_share")).toBe(50);
    expect(val(m, "would_visit_anyway_share")).toBe(50);
    expect(val(m, "attributable_fraction")).toBe(50);
    const nonlocal = 90 * (2 / 3);
    expect(val(m, "gross_visitor_spend")).toBeCloseTo(nonlocal * 1000, 6);
    expect(val(m, "total_visitor_days")).toBeCloseTo(nonlocal * 1.5, 6);
    expect(val(m, "spend_per_visitor_day")).toBeCloseTo(1000 / 1.5, 6);
    expect(val(m, "total_visitor_nights")).toBeCloseTo(nonlocal * 0.5 * 2, 6);
    expect(val(m, "attributable_visitor_spend")).toBeCloseTo(nonlocal * 750, 6); // only a counts: (1500 + 0) / 2
  });

  it("data quality: Kish effective sample size and margin of error with finite population correction", () => {
    const m = computeKpis(base({ tickets: { valid: 1000, cancelled: 0, checkedIn: 1000, leadDaysSum: 0, leadDaysN: 0 },
      responses: [r({ weight: 1 }), r({ weight: 3 })] }));
    expect(val(m, "effective_sample_size")).toBeCloseTo(16 / 10, 10);
    expect(val(m, "survey_margin_of_error")).toBeCloseTo(1.96 * Math.sqrt(0.25 / 2) * Math.sqrt(998 / 999) * 100, 10);
  });
});

describe("finance (budget lines, actual amounts)", () => {
  const line = (o: Partial<FinanceLine> & Pick<FinanceLine, "kind" | "category">): FinanceLine => ({
    plannedKurus: null, actualKurus: null, quantity: null, costBehavior: null, supplierLocal: null, fundedExternally: null, ...o,
  });
  const tickets = { valid: 1000, cancelled: 0, checkedIn: 800, leadDaysSum: 0, leadDaysN: 0 };
  const lines: FinanceLine[] = [
    line({ kind: "INCOME", category: "TICKETS", actualKurus: 30_000_000, plannedKurus: 40_000_000, quantity: 1000 }), // 300,000 TL, 300 TL/ticket
    line({ kind: "INCOME", category: "SPONSORSHIP", actualKurus: 10_000_000 }),
    line({ kind: "INCOME", category: "EXHIBITOR", actualKurus: 5_000_000 }),
    line({ kind: "INCOME", category: "GRANT", plannedKurus: 9_900_000 }), // planned only: not in actuals
    line({ kind: "COST", category: "VENUE", actualKurus: 20_000_000, plannedKurus: 18_000_000, costBehavior: "FIXED", supplierLocal: true, fundedExternally: true }),
    line({ kind: "COST", category: "MARKETING", actualKurus: 5_000_000, plannedKurus: 5_000_000, costBehavior: "FIXED", supplierLocal: false, fundedExternally: true }),
    line({ kind: "COST", category: "CATERING", actualKurus: 8_000_000, costBehavior: "VARIABLE", supplierLocal: true, fundedExternally: false }), // 100 TL / attendee
    line({ kind: "TICKET_ADJUSTMENT", category: "REFUND", actualKurus: 2_000_000 }),
    line({ kind: "TICKET_ADJUSTMENT", category: "DISCOUNT", actualKurus: 3_000_000 }),
  ];

  it("follows the document's formulas", () => {
    const m = computeKpis(base({ tickets, finance: { lines } }));
    expect(val(m, "ticket_revenue")).toBe(300_000);
    expect(val(m, "sponsorship_revenue")).toBe(100_000);
    expect(val(m, "exhibitor_revenue")).toBe(50_000);
    expect(val(m, "total_revenue")).toBe(450_000);
    expect(val(m, "total_organizer_cost")).toBe(330_000);
    expect(val(m, "net_profit")).toBe(120_000);
    expect(val(m, "event_roi")).toBeCloseTo((120_000 / 330_000) * 100, 10);
    expect(val(m, "cost_per_attendee")).toBe(330_000 / 800);
    expect(val(m, "revenue_per_attendee")).toBe(450_000 / 800);
    expect(val(m, "avg_ticket_price")).toBe(300);
    // gross ticket revenue 300,000 + 20,000 + 30,000 = 350,000
    expect(val(m, "refund_rate")).toBeCloseTo((20_000 / 350_000) * 100, 10);
    expect(val(m, "discount_rate")).toBeCloseTo((30_000 / 350_000) * 100, 10);
    // cost lines with plan and actual: 250,000 vs 230,000
    expect(val(m, "budget_variance_pct")).toBeCloseTo((20_000 / 230_000) * 100, 10);
    // fixed 250,000 / (300 − 80,000/800) = 250,000 / 200 = 1,250
    expect(val(m, "break_even_attendees")).toBe(1250);
    expect(val(m, "cost_per_registration")).toBe(50);
    expect(val(m, "eligible_nonlocal_financed_local_spend")).toBe(200_000);
  });

  it("empty is not zero: no actual line → null; finance hidden → null with a note", () => {
    const m = computeKpis(base({ tickets, finance: { lines: [line({ kind: "COST", category: "VENUE", plannedKurus: 100 })] } }));
    for (const id of ["total_revenue", "total_organizer_cost", "net_profit", "event_roi", "budget_variance_pct", "break_even_attendees"]) {
      expect(val(m, id), id).toBeNull();
    }
    const hidden = computeKpis(base({ tickets, finance: null }));
    expect(hidden.get("net_profit")).toMatchObject({ value: null, reason: "no_data" });
    expect(hidden.get("net_profit")!.note).toMatch(/yalnızca kurum sahibi/);
  });

  it("break-even needs every cost classified and a positive margin; local spend needs every cost flagged", () => {
    const unclassified = lines.map((l) => (l.category === "CATERING" ? { ...l, costBehavior: null } : l));
    const m1 = computeKpis(base({ tickets, finance: { lines: unclassified } }));
    expect(m1.get("break_even_attendees")).toMatchObject({ value: null });
    expect(m1.get("break_even_attendees")!.note).toMatch(/işaretlenmemiş/);
    const expensive = lines.map((l) => (l.category === "CATERING" ? { ...l, actualKurus: 30_000_000 } : l)); // 375 TL / attendee > 300
    expect(computeKpis(base({ tickets, finance: { lines: expensive } })).get("break_even_attendees")!.note).toMatch(/marj ≤ 0/);
    const unflagged = lines.map((l) => (l.category === "VENUE" ? { ...l, supplierLocal: null } : l));
    expect(val(computeKpis(base({ tickets, finance: { lines: unflagged } })), "eligible_nonlocal_financed_local_spend")).toBeNull();
    // only fixed costs: no attendees needed
    const fixedOnly = lines.filter((l) => l.category !== "CATERING");
    expect(val(computeKpis(base({ tickets: { ...tickets, checkedIn: 0 }, finance: { lines: fixedOnly } })), "break_even_attendees")).toBe(Math.ceil(250_000 / 300));
  });

  it("a free event records a 0 income line: revenue 0, ROI −100 %", () => {
    const free = [line({ kind: "INCOME", category: "OTHER", actualKurus: 0 }), line({ kind: "COST", category: "VENUE", actualKurus: 1_000_000, costBehavior: "FIXED" })];
    const m = computeKpis(base({ tickets, finance: { lines: free } }));
    expect(val(m, "total_revenue")).toBe(0);
    expect(val(m, "event_roi")).toBe(-100);
  });
});
