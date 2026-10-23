/**
 * KPI engine (pure, deterministic): computes the catalog metrics (src/lib/kpi/catalog.ts) that the platform has
 * inputs for, with the formulas of the organization's reference document. General rules (document §3):
 *   - a ratio whose denominator is 0 is empty (null, reason "zero_denominator"), never 0 or a guess;
 *   - survey means are weighted: Σ(w·x) / Σw over valid answers; weighted share = Σ(w·1[cond]) / Σw × 100;
 *   - Likert is 1–5, NPS 0–10.
 *
 * Choices this file makes where the document leaves a T (design) decision, stated so reports can cite them:
 *   - "kayıtlı" (registered) = issued tickets that are not cancelled; cancellation rate uses issued tickets
 *     (cancelled + valid) as the base, because a cancelled ticket was a registration first.
 *   - visitor population for survey extrapolation = checked-in attendees, else valid tickets (basis reported).
 *   - visitor-spend metrics use the non-resident segment (q_is_local = false) and per-person amounts
 *     (party spend ÷ party size). A respondent counts once they answered at least one spend question; an
 *     unanswered category of such a respondent is 0 (the questionnaire asks to write 0 when nothing was spent).
 *   - local spend = accommodation, food & beverage, local transport, shopping, entertainment & culture, other;
 *     intercity transport and organizer-side categories are excluded (document: no double counting).
 *   - attributable fraction: strict rule within the non-resident segment — main reason = the event AND
 *     "would not have come otherwise" (= "no"); no partial credit (document §4.1: start strict).
 *   - csat threshold: 4 and 5 on the 1–5 scale (top-2 box).
 *   - finance (budget_items, actual amounts only; a total with no actual line is empty, not 0 — a free event records
 *     a 0 income line): "gelen" (attendees) = check-ins; event ROI is the financial ROI with Value = total revenue
 *     (ticket income is recorded net of refunds and discounts); gross ticket revenue = net ticket income + refunds +
 *     discounts; budget variance over cost lines that have both a plan and an actual; break-even needs every cost
 *     line marked fixed or variable, variable cost per attendee = variable costs ÷ check-ins; organizer local spend
 *     needs every cost line marked for supplier location and funding source.
 */
import { SPEND_CATEGORIES, type SpendCategoryValue } from "@/lib/metrics/question-bank";
import { computeExternalKpis, EMPTY_EXTERNAL, type ExternalData } from "@/lib/kpi/external";
import { computeDatasetKpis, type ConfirmedDataset } from "@/lib/kpi/datasets";

export const KPI_ENGINE_VERSION = "kpi-engine/1.3.0" as const;

export const LOCAL_SPEND_CATEGORIES = [
  "ACCOMMODATION", "FOOD_BEVERAGE", "LOCAL_TRANSPORT", "RETAIL_SHOPPING", "ENTERTAINMENT_CULTURE", "OTHER",
] as const satisfies readonly SpendCategoryValue[];

const CATEGORY_METRIC: Record<(typeof LOCAL_SPEND_CATEGORIES)[number], string> = {
  ACCOMMODATION: "accommodation_spend_per_visitor",
  FOOD_BEVERAGE: "food_spend_per_visitor",
  LOCAL_TRANSPORT: "local_transport_spend_per_visitor",
  RETAIL_SHOPPING: "shopping_spend_per_visitor",
  ENTERTAINMENT_CULTURE: "entertainment_spend_per_visitor",
  OTHER: "other_spend_per_visitor",
};

export interface KpiResponse {
  weight: number;
  isLocalResident: boolean | null;
  homeProvinceCode: number | null;
  partySize: number | null;
  daysPresent: number | null;
  nightsStayed: number | null;
  mainReason: string | null;
  wouldVisitAnyway: string | null;
  nps: number | null;
  overallSatisfaction: number | null;
  accessibilitySatisfaction: number | null;
  attendedBefore: boolean | null;
  /** Party total for the whole stay, kuruş, per answered category. */
  spendKurus: Partial<Record<SpendCategoryValue, number>>;
}

export interface FinanceLine {
  kind: "INCOME" | "COST" | "TICKET_ADJUSTMENT";
  category: string;
  plannedKurus: number | null;
  actualKurus: number | null;
  quantity: number | null;
  costBehavior: "FIXED" | "VARIABLE" | null;
  supplierLocal: boolean | null;
  fundedExternally: boolean | null;
}

export interface KpiDataset {
  tickets: { valid: number; cancelled: number; checkedIn: number; leadDaysSum: number; leadDaysN: number };
  capacity: number | null;
  eventFinished: boolean;
  tasks: { dueReached: number; onTime: number };
  /** Attendee-audience responses that are not excluded. */
  responses: readonly KpiResponse[];
  /** Budget lines; null when the caller may not see finance data (budget.read). */
  finance: { lines: readonly FinanceLine[] } | null;
  /** External sources, press mentions, sponsor / lead uploads (src/lib/kpi/external.ts). */
  external?: ExternalData;
  /** The organization's own uploaded tables with a confirmed column mapping (src/lib/kpi/datasets.ts). */
  datasets?: readonly ConfirmedDataset[];
}

export const FINANCE_KPI_IDS = [
  "ticket_revenue", "sponsorship_revenue", "exhibitor_revenue", "total_revenue", "total_organizer_cost", "net_profit", "event_roi",
  "cost_per_attendee", "revenue_per_attendee", "avg_ticket_price", "refund_rate", "discount_rate", "budget_variance_pct",
  "break_even_attendees", "cost_per_registration", "eligible_nonlocal_financed_local_spend",
] as const;

export type NullReason = "no_data" | "zero_denominator";

export interface KpiValue {
  id: string;
  value: number | null;
  reason?: NullReason;
  /** Number of valid answers / units behind the value. */
  n?: number;
  /** Lower and upper bound (nps_ci95). */
  interval?: [number, number];
  note?: string;
}

// ------------------------------------------------------------------------------------------- helpers

const ratio = (num: number, den: number, scale = 100): number | null => (den > 0 ? (num / den) * scale : null);

function weightedMean(items: readonly { w: number; x: number }[]) {
  let sw = 0;
  let swx = 0;
  for (const { w, x } of items) {
    sw += w;
    swx += w * x;
  }
  return { value: sw > 0 ? swx / sw : null, n: items.length };
}

function weightedShare<T>(items: readonly T[], weight: (t: T) => number, cond: (t: T) => boolean) {
  let sw = 0;
  let swc = 0;
  for (const it of items) {
    const w = weight(it);
    sw += w;
    if (cond(it)) swc += w;
  }
  return { value: sw > 0 ? (swc / sw) * 100 : null, n: items.length };
}

const v = (id: string, value: number | null, extra: Omit<KpiValue, "id" | "value"> = {}): KpiValue =>
  value === null || !Number.isFinite(value)
    ? { id, value: null, reason: extra.reason ?? ((extra.n ?? 0) === 0 ? "no_data" : "zero_denominator"), ...extra }
    : { id, value, ...extra };

const kurusToTry = (k: number) => k / 100;
const localSpendKurus = (r: KpiResponse) => LOCAL_SPEND_CATEGORIES.reduce((s, c) => s + (r.spendKurus[c] ?? 0), 0);
const answeredSpend = (r: KpiResponse) => SPEND_CATEGORIES.some((c) => r.spendKurus[c] !== undefined);

// ------------------------------------------------------------------------------------------- engine

export function computeKpis(ds: KpiDataset): Map<string, KpiValue> {
  const out = new Map<string, KpiValue>();
  const put = (k: KpiValue) => out.set(k.id, k);
  const t = ds.tickets;
  const issued = t.valid + t.cancelled;
  const ongoing = ds.eventFinished ? undefined : "Etkinlik sürüyor; değer etkinlik bitince kesinleşir.";

  // --- registration & attendance
  put(v("registered_count", t.valid, { n: t.valid, reason: "no_data" }));
  put(v("cancellation_rate", ratio(t.cancelled, issued), { n: issued }));
  put(v("attended_count", t.checkedIn, { n: t.checkedIn }));
  put(v("attendance_rate", ratio(t.checkedIn, t.valid), { n: t.valid, note: ongoing }));
  put(v("no_show_rate", ratio(t.valid - t.checkedIn, t.valid), { n: t.valid, note: ongoing }));
  put(v("capacity_utilization", ds.capacity ? ratio(t.checkedIn, ds.capacity) : null, {
    n: t.checkedIn, ...(ds.capacity ? {} : { reason: "no_data", note: "Etkinlik profilinde kapasite yok." }),
  }));
  put(v("registration_lead_time_avg_days", t.leadDaysN > 0 ? t.leadDaysSum / t.leadDaysN : null, { n: t.leadDaysN }));
  put(v("task_on_time_rate", ratio(ds.tasks.onTime, ds.tasks.dueReached), { n: ds.tasks.dueReached }));

  // visitor population for extrapolating survey shares
  const population = t.checkedIn > 0 ? t.checkedIn : t.valid > 0 ? t.valid : null;
  const populationNote = t.checkedIn > 0 ? "Ziyaretçi sayısı: check-in." : t.valid > 0 ? "Ziyaretçi sayısı: geçerli bilet (check-in yok)." : undefined;

  const R = ds.responses.filter((r) => r.weight > 0);
  const w = (r: KpiResponse) => r.weight;

  // --- experience
  const npsR = R.filter((r) => r.nps !== null);
  if (npsR.length) {
    const sw = npsR.reduce((s, r) => s + r.weight, 0);
    const p = npsR.reduce((s, r) => s + (r.nps! >= 9 ? r.weight : 0), 0) / sw;
    const dd = npsR.reduce((s, r) => s + (r.nps! <= 6 ? r.weight : 0), 0) / sw;
    const nps = (p - dd) * 100;
    const half = 1.96 * 100 * Math.sqrt((p + dd - (p - dd) ** 2) / npsR.length);
    put(v("nps", nps, { n: npsR.length }));
    put(v("promoter_share", p * 100, { n: npsR.length }));
    put(v("detractor_share", dd * 100, { n: npsR.length }));
    put(v("nps_ci95", half, { n: npsR.length, interval: [nps - half, nps + half], note: "± yarı genişlik (NPS puanı)" }));
  } else {
    for (const id of ["nps", "promoter_share", "detractor_share", "nps_ci95"]) put(v(id, null, { n: 0 }));
  }
  const sat = R.filter((r) => r.overallSatisfaction !== null);
  put(v("overall_satisfaction", weightedMean(sat.map((r) => ({ w: r.weight, x: r.overallSatisfaction! }))).value, { n: sat.length }));
  put(v("csat", weightedShare(sat, w, (r) => r.overallSatisfaction! >= 4).value, { n: sat.length }));
  const acc = R.filter((r) => r.accessibilitySatisfaction !== null);
  put(v("accessibility_satisfaction", weightedMean(acc.map((r) => ({ w: r.weight, x: r.accessibilitySatisfaction! }))).value, { n: acc.length }));
  const ret = R.filter((r) => r.attendedBefore !== null);
  put(v("returning_attendee_rate", weightedShare(ret, w, (r) => r.attendedBefore === true).value, {
    n: ret.length, note: "Anket yanıtlarından ağırlıklı tahmin.",
  }));
  const prov = R.filter((r) => r.homeProvinceCode !== null);
  put(v("international_share", weightedShare(prov, w, (r) => r.homeProvinceCode === 0).value, { n: prov.length }));

  // --- visitor spend (non-resident segment)
  const loc = R.filter((r) => r.isLocalResident !== null);
  const nonlocalShare = weightedShare(loc, w, (r) => r.isLocalResident === false);
  put(v("nonlocal_share", nonlocalShare.value, { n: loc.length }));
  const NL = R.filter((r) => r.isLocalResident === false);
  const reason = NL.filter((r) => r.mainReason !== null);
  put(v("event_primary_purpose_share", weightedShare(reason, w, (r) => r.mainReason === "event").value, { n: reason.length }));
  const anyway = NL.filter((r) => r.wouldVisitAnyway !== null);
  put(v("would_visit_anyway_share", weightedShare(anyway, w, (r) => r.wouldVisitAnyway === "yes").value, { n: anyway.length }));

  const spenders = NL.filter((r) => answeredSpend(r) && r.partySize !== null && r.partySize > 0);
  const perPerson = (r: KpiResponse, kurus: number) => kurusToTry(kurus) / r.partySize!;
  for (const c of LOCAL_SPEND_CATEGORIES) {
    put(v(CATEGORY_METRIC[c], weightedMean(spenders.map((r) => ({ w: r.weight, x: perPerson(r, r.spendKurus[c] ?? 0) }))).value, { n: spenders.length }));
  }
  const spendPerVisitor = weightedMean(spenders.map((r) => ({ w: r.weight, x: perPerson(r, localSpendKurus(r)) })));
  put(v("spend_per_visitor", spendPerVisitor.value, { n: spenders.length }));
  const daily = spenders.filter((r) => r.daysPresent !== null && r.daysPresent > 0);
  put(v("avg_daily_spend", weightedMean(daily.map((r) => ({ w: r.weight, x: perPerson(r, localSpendKurus(r)) / r.daysPresent! }))).value, { n: daily.length }));

  const nights = NL.filter((r) => r.nightsStayed !== null);
  const stayShare = weightedShare(nights, w, (r) => r.nightsStayed! > 0);
  put(v("accommodation_use_rate", stayShare.value, { n: nights.length }));
  const stayers = nights.filter((r) => r.nightsStayed! > 0);
  const avgNights = weightedMean(stayers.map((r) => ({ w: r.weight, x: r.nightsStayed! })));
  put(v("avg_nights_stayed", avgNights.value, { n: stayers.length }));
  const days = NL.filter((r) => r.daysPresent !== null && r.daysPresent > 0);
  const avgDays = weightedMean(days.map((r) => ({ w: r.weight, x: r.daysPresent! })));

  const nonlocalVisitors = population !== null && nonlocalShare.value !== null ? population * (nonlocalShare.value / 100) : null;
  const gross = nonlocalVisitors !== null && spendPerVisitor.value !== null ? nonlocalVisitors * spendPerVisitor.value : null;
  put(v("gross_visitor_spend", gross, { n: spenders.length, note: populationNote }));
  put(v("total_visitor_nights",
    nonlocalVisitors !== null && stayShare.value !== null ? nonlocalVisitors * (stayShare.value / 100) * (avgNights.value ?? 0) : null,
    { n: nights.length, note: populationNote }));
  const totalDays = nonlocalVisitors !== null && avgDays.value !== null ? nonlocalVisitors * avgDays.value : null;
  put(v("total_visitor_days", totalDays, { n: days.length, note: populationNote }));
  put(v("spend_per_visitor_day", gross !== null && totalDays ? gross / totalDays : null, { n: spenders.length }));

  // --- attributable net injection (strict rule)
  const decided = NL.filter((r) => r.mainReason !== null && r.wouldVisitAnyway !== null);
  const strict = (r: KpiResponse) => r.mainReason === "event" && r.wouldVisitAnyway === "no";
  put(v("attributable_fraction", weightedShare(decided, w, strict).value, { n: decided.length, note: "Katı kural, şehir dışı ziyaretçiler içinde." }));
  const attrib = spenders.filter((r) => r.mainReason !== null && r.wouldVisitAnyway !== null);
  const attribPerVisitor = weightedMean(attrib.map((r) => ({ w: r.weight, x: strict(r) ? perPerson(r, localSpendKurus(r)) : 0 })));
  put(v("attributable_visitor_spend",
    nonlocalVisitors !== null && attribPerVisitor.value !== null ? nonlocalVisitors * attribPerVisitor.value : null,
    { n: attrib.length, note: populationNote }));


  // --- finance (budget lines, actual amounts)
  if (!ds.finance) {
    for (const id of FINANCE_KPI_IDS) put(v(id, null, { n: 0, reason: "no_data", note: "Bütçe verisi yalnızca kurum sahibi ve yöneticiye açık." }));
  } else {
    const actual = ds.finance.lines.filter((l) => l.actualKurus !== null);
    const sumTry = (ls: readonly FinanceLine[]) => (ls.length ? kurusToTry(ls.reduce((x, l) => x + l.actualKurus!, 0)) : null);
    const of = (kind: FinanceLine["kind"], category?: string) => actual.filter((l) => l.kind === kind && (category === undefined || l.category === category));
    const ticketLines = of("INCOME", "TICKETS");
    const incomeLines = of("INCOME");
    const costLines = of("COST");
    const ticketRevenue = sumTry(ticketLines);
    const revenue = sumTry(incomeLines);
    const cost = sumTry(costLines);
    put(v("ticket_revenue", ticketRevenue, { n: ticketLines.length }));
    put(v("sponsorship_revenue", sumTry(of("INCOME", "SPONSORSHIP")), { n: of("INCOME", "SPONSORSHIP").length }));
    put(v("exhibitor_revenue", sumTry(of("INCOME", "EXHIBITOR")), { n: of("INCOME", "EXHIBITOR").length }));
    put(v("total_revenue", revenue, { n: incomeLines.length }));
    put(v("total_organizer_cost", cost, { n: costLines.length }));
    const both = revenue !== null && cost !== null;
    put(v("net_profit", both ? revenue - cost : null, { n: both ? incomeLines.length + costLines.length : 0 }));
    put(v("event_roi", both ? ratio(revenue - cost, cost) : null, {
      n: both ? costLines.length : 0, note: "Finansal ROI: Değer = toplam gelir (bilet geliri iade ve indirim düşülmüş).",
    }));
    const attendees = t.checkedIn;
    put(v("cost_per_attendee", cost !== null ? ratio(cost, attendees, 1) : null, { n: cost !== null ? attendees : 0, note: "Gelen = check-in." }));
    put(v("revenue_per_attendee", revenue !== null ? ratio(revenue, attendees, 1) : null, { n: revenue !== null ? attendees : 0, note: "Gelen = check-in." }));
    const priced = ticketLines.filter((l) => l.quantity !== null);
    const paidTickets = priced.reduce((x, l) => x + l.quantity!, 0);
    const avgPrice = priced.length ? ratio(kurusToTry(priced.reduce((x, l) => x + l.actualKurus!, 0)), paidTickets, 1) : null;
    put(v("avg_ticket_price", avgPrice, { n: paidTickets, ...(priced.length ? {} : { note: "Bilet geliri satırında satılan bilet adedi yok." }) }));
    const refunds = sumTry(of("TICKET_ADJUSTMENT", "REFUND")) ?? 0;
    const discounts = sumTry(of("TICKET_ADJUSTMENT", "DISCOUNT")) ?? 0;
    const gross = ticketRevenue !== null ? ticketRevenue + refunds + discounts : null;
    const grossNote = "Brüt bilet geliri = net bilet geliri + iade + indirim.";
    put(v("refund_rate", gross !== null ? ratio(refunds, gross) : null, { n: ticketLines.length, note: grossNote }));
    put(v("discount_rate", gross !== null ? ratio(discounts, gross) : null, { n: ticketLines.length, note: grossNote }));
    const planned = ds.finance.lines.filter((l) => l.kind === "COST" && l.plannedKurus !== null && l.actualKurus !== null);
    const pSum = planned.reduce((x, l) => x + l.plannedKurus!, 0);
    const aSum = planned.reduce((x, l) => x + l.actualKurus!, 0);
    put(v("budget_variance_pct", planned.length ? ratio(aSum - pSum, pSum) : null, {
      n: planned.length, note: "Planı ve gerçekleşeni olan gider kalemleri; pozitif = aşım.",
    }));
    // break-even: every actual cost line classified; variable cost per attendee from check-ins
    const unclassified = costLines.filter((l) => l.costBehavior === null).length;
    const fixed = kurusToTry(costLines.filter((l) => l.costBehavior === "FIXED").reduce((x, l) => x + l.actualKurus!, 0));
    const variable = kurusToTry(costLines.filter((l) => l.costBehavior === "VARIABLE").reduce((x, l) => x + l.actualKurus!, 0));
    const varPer = variable === 0 ? 0 : attendees > 0 ? variable / attendees : null;
    let breakEven: number | null = null;
    let beNote: string | undefined;
    if (!costLines.length) beNote = undefined;
    else if (unclassified) beNote = `${unclassified} gider kalemi sabit/değişken olarak işaretlenmemiş.`;
    else if (avgPrice === null) beNote = "Ortalama bilet fiyatı yok.";
    else if (varPer === null) beNote = "Değişken gider var ama check-in yok.";
    else if (avgPrice - varPer <= 0) beNote = "Bilet başı marj ≤ 0: başabaş noktası yok.";
    else breakEven = Math.ceil(fixed / (avgPrice - varPer));
    put(v("break_even_attendees", breakEven, { n: costLines.length, ...(breakEven === null && costLines.length ? { reason: "no_data" as const } : {}), ...(beNote ? { note: beNote } : {}) }));
    const marketing = sumTry(of("COST", "MARKETING"));
    put(v("cost_per_registration", marketing !== null ? ratio(marketing, t.valid, 1) : null, { n: marketing !== null ? t.valid : 0, note: "Pazarlama gideri / geçerli bilet." }));
    const unflagged = costLines.filter((l) => l.supplierLocal === null || l.fundedExternally === null).length;
    const eligible = costLines.filter((l) => l.supplierLocal && l.fundedExternally);
    put(v("eligible_nonlocal_financed_local_spend", costLines.length && !unflagged ? kurusToTry(eligible.reduce((x, l) => x + l.actualKurus!, 0)) : null, {
      n: eligible.length, ...(unflagged ? { reason: "no_data" as const, note: `${unflagged} gider kaleminde tedarikçi yeri veya finansman kaynağı işaretlenmemiş.` } : {}),
    }));
  }

  // --- external data (connectors, press, CSV); money metrics only with finance access
  const leadProgram = ds.finance?.lines.filter((l) => l.kind === "COST" && l.category === "LEAD_PROGRAM" && l.actualKurus !== null) ?? [];
  const external = { ...(ds.external ?? EMPTY_EXTERNAL), leadProgramCostKurus: leadProgram.length ? leadProgram.reduce((x, l) => x + l.actualKurus!, 0) : null };
  for (const x of computeExternalKpis(external, ds.finance !== null)) put(x);
  for (const x of computeDatasetKpis(ds.datasets ?? [], { checkedIn: t.checkedIn, validTickets: t.valid })) put(x);

  // --- data quality
  const sw = R.reduce((s, r) => s + r.weight, 0);
  const sw2 = R.reduce((s, r) => s + r.weight ** 2, 0);
  put(v("effective_sample_size", sw2 > 0 ? (sw * sw) / sw2 : null, { n: R.length }));
  const n = R.length;
  let moe: number | null = null;
  if (n > 0) {
    const fpc = population !== null && population > 1 && n <= population ? Math.sqrt((population - n) / (population - 1)) : 1;
    moe = 1.96 * Math.sqrt(0.25 / n) * fpc * 100;
  }
  put(v("survey_margin_of_error", moe, { n, note: population !== null ? `N = ${population}` : "Sonlu evren düzeltmesi yok (N bilinmiyor)." }));

  return out;
}
