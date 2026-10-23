/**
 * Metrics and summaries from the organization's own uploaded tables (Excel / CSV) whose column mapping a person
 * confirmed (src/lib/datasets/measures.ts). Formulas are the KPI reference's (catalog); "gelen" (attended) is the
 * platform's check-in count, or — when the event has no check-ins — the uploaded visitor counts (stated in notes).
 *
 * Row-wise pairs (session check-ins vs registrations or capacity, event vs baseline sales, activity × emission
 * factor) use only rows where both values are present, so a missing cell never counts as zero.
 */
import type { Column, Value } from "@/lib/datasets/table";
import { MEASURE_BY_KEY, type ColumnMapping } from "@/lib/datasets/measures";

export interface ConfirmedDataset { id: string; name: string; columns: readonly Column[]; rows: readonly Value[][]; mapping: readonly ColumnMapping[] }

type Val = { id: string; value: number | null; reason?: "no_data" | "zero_denominator"; n?: number; note?: string };

/** Catalog ids this module computes. */
export const DATASET_KPI_IDS = [
  "waste_per_attendee_kg", "recycling_rate", "carbon_footprint_kgco2e", "carbon_per_attendee_kgco2e",
  "incident_rate_per_1000", "complaint_rate_per_1000", "issue_resolution_avg_minutes", "checkin_avg_minutes", "checkin_p90_minutes",
  "additional_staff", "attendees_per_staff", "badge_reprint_rate", "vendor_on_time_rate", "schedule_adherence_rate",
  "session_attendance_rate", "session_fill_rate", "avg_sessions_per_attendee", "session_satisfaction",
  "meeting_completion_rate", "meetings_per_attendee", "qa_participation_rate", "poll_response_rate", "active_engagement_rate",
  "virtual_attendance_rate", "peak_concurrent_viewers", "avg_watch_minutes", "vendor_revenue_change",
  "registration_completion_rate", "waitlist_conversion_rate", "walk_in_share", "early_bird_share",
] as const;

const ratio = (a: number, b: number, scale = 100) => (b > 0 ? (a / b) * scale : null);
const val = (id: string, value: number | null, extra: Omit<Val, "id" | "value"> = {}): Val =>
  value === null || !Number.isFinite(value)
    ? { id, value: null, reason: extra.reason ?? ((extra.n ?? 0) === 0 ? "no_data" : "zero_denominator"), ...extra }
    : { id, value, ...extra };

/** Values of one measure across datasets: { dataset name, row index, value }. */
function collect(datasets: readonly ConfirmedDataset[]) {
  const by = new Map<string, { ds: string; row: number; v: number | boolean }[]>();
  for (const d of datasets) {
    for (const m of d.mapping) {
      if (!m.role.startsWith("measure:")) continue;
      const key = m.role.slice(8);
      const j = d.columns.findIndex((c) => c.key === m.key);
      if (j < 0) continue;
      const list = by.get(key) ?? by.set(key, []).get(key)!;
      d.rows.forEach((r, i) => {
        const v = r[j];
        if (typeof v === "number" || typeof v === "boolean") list.push({ ds: d.id, row: i, v });
      });
    }
  }
  return by;
}

export function computeDatasetKpis(datasets: readonly ConfirmedDataset[], platform: { checkedIn: number; validTickets: number }): Val[] {
  const by = collect(datasets);
  const nums = (k: string) => (by.get(k) ?? []).filter((x) => typeof x.v === "number").map((x) => x.v as number);
  const has = (k: string) => (by.get(k) ?? []).length > 0;
  const sum = (k: string) => nums(k).reduce((s, x) => s + x, 0);
  const sources = (keys: string[]) => {
    const ids = new Set(keys.flatMap((k) => (by.get(k) ?? []).map((x) => x.ds)));
    const names = datasets.filter((d) => ids.has(d.id)).map((d) => d.name);
    return names.length ? `Kurum verisi: ${names.join(", ")}.` : "Kurum verisi yüklenmedi (Analizler → Kendi verileriniz).";
  };
  /** Rows where both measures have a number (same dataset and row). */
  const pairs = (a: string, b: string) => {
    const right = new Map((by.get(b) ?? []).map((x) => [`${x.ds}:${x.row}`, x.v]));
    return (by.get(a) ?? []).flatMap((x) => {
      const y = right.get(`${x.ds}:${x.row}`);
      return typeof x.v === "number" && typeof y === "number" ? [[x.v, y] as const] : [];
    });
  };
  const visitors = sum("visitors");
  const gelen = platform.checkedIn > 0 ? platform.checkedIn : visitors;
  const gelenNote = platform.checkedIn > 0 ? "Gelen = check-in." : visitors > 0 ? "Gelen = yüklenen ziyaretçi sayımı (check-in yok)." : "Gelen sayısı yok.";
  const out: Val[] = [];
  const put = (x: Val) => out.push(x);
  const perGelen = (id: string, key: string, scale: number) =>
    put(val(id, has(key) ? ratio(sum(key), gelen, scale) : null, { n: nums(key).length, note: `${sources([key])}${has(key) ? ` ${gelenNote}` : ""}` }));
  const share = (id: string, a: string, b: string) =>
    put(val(id, has(a) && has(b) ? ratio(sum(a), sum(b)) : null, { n: nums(b).length, note: sources([a, b]) }));
  const paired = (id: string, a: string, b: string, f: (x: number, y: number) => number | null) => {
    const p = pairs(a, b);
    const sa = p.reduce((s, [x]) => s + x, 0), sb = p.reduce((s, [, y]) => s + y, 0);
    put(val(id, p.length ? f(sa, sb) : null, { n: p.length, note: `${sources([a, b])}${p.length ? " İki değeri de olan satırlar." : ""}` }));
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const truthShare = (id: string, key: string) => {
    const xs = (by.get(key) ?? []).filter((x) => typeof x.v === "boolean");
    put(val(id, xs.length ? ratio(xs.filter((x) => x.v === true).length, xs.length) : null, { n: xs.length, note: sources([key]) }));
  };

  // sustainability
  perGelen("waste_per_attendee_kg", "waste_kg", 1);
  share("recycling_rate", "recycled_kg", "waste_kg");
  const product = pairs("emission_activity", "emission_factor").reduce((s, [a, f]) => s + a * f, 0);
  const carbonKnown = has("co2e_kg") || pairs("emission_activity", "emission_factor").length > 0;
  const carbon = sum("co2e_kg") + product;
  const carbonNote = `${sources(["co2e_kg", "emission_activity", "emission_factor"])} Faktörlerin kaynağı, yılı ve kapsamı rapor edilmelidir.`;
  put(val("carbon_footprint_kgco2e", carbonKnown ? carbon : null, { n: nums("co2e_kg").length + pairs("emission_activity", "emission_factor").length, note: carbonNote }));
  put(val("carbon_per_attendee_kgco2e", carbonKnown ? ratio(carbon, gelen, 1) : null, { n: carbonKnown ? 1 : 0, note: `${carbonNote} ${gelenNote}` }));

  // operations and experience
  perGelen("incident_rate_per_1000", "incidents", 1000);
  perGelen("complaint_rate_per_1000", "complaints", 1000);
  put(val("issue_resolution_avg_minutes", mean(nums("issue_resolution_minutes")), { n: nums("issue_resolution_minutes").length, note: sources(["issue_resolution_minutes"]) }));
  const waits = [...nums("checkin_wait_minutes")].sort((a, b) => a - b);
  put(val("checkin_avg_minutes", mean(waits), { n: waits.length, note: sources(["checkin_wait_minutes"]) }));
  put(val("checkin_p90_minutes", waits.length ? waits[Math.max(0, Math.ceil(0.9 * waits.length) - 1)]! : null, {
    n: waits.length, note: `${sources(["checkin_wait_minutes"])}${waits.length ? " 90. yüzdelik (en yakın sıra)." : ""}` }));
  put(val("additional_staff", has("additional_staff") ? sum("additional_staff") : null, { n: nums("additional_staff").length, note: sources(["additional_staff"]) }));
  put(val("attendees_per_staff", has("staff") ? ratio(gelen, sum("staff"), 1) : null, { n: nums("staff").length, note: `${sources(["staff"])}${has("staff") ? ` ${gelenNote}` : ""}` }));
  share("badge_reprint_rate", "badge_reprints", "badges_printed");
  truthShare("vendor_on_time_rate", "vendor_on_time");
  truthShare("schedule_adherence_rate", "session_on_time");

  // sessions and engagement
  paired("session_attendance_rate", "session_checkins", "session_registered", (a, b) => ratio(a, b));
  paired("session_fill_rate", "session_checkins", "session_capacity", (a, b) => ratio(a, b));
  perGelen("avg_sessions_per_attendee", "session_checkins", 1);
  const ratings = nums("session_rating").filter((x) => x >= 1 && x <= 5);
  put(val("session_satisfaction", mean(ratings), { n: ratings.length, note: `${sources(["session_rating"])}${nums("session_rating").length > ratings.length ? " 1–5 dışındaki değerler alınmadı." : ""}` }));
  share("meeting_completion_rate", "meetings_held", "meetings_planned");
  perGelen("meetings_per_attendee", "meetings_held", 1);
  perGelen("qa_participation_rate", "qa_participants", 100);
  perGelen("poll_response_rate", "poll_respondents", 100);
  perGelen("active_engagement_rate", "active_engaged", 100);

  // virtual
  share("virtual_attendance_rate", "live_viewers", "virtual_registered");
  const conc = nums("concurrent_viewers");
  put(val("peak_concurrent_viewers", conc.length ? Math.max(...conc) : null, { n: conc.length, note: sources(["concurrent_viewers"]) }));
  put(val("avg_watch_minutes", mean(nums("watch_minutes")), { n: nums("watch_minutes").length, note: sources(["watch_minutes"]) }));

  // local business and registration
  paired("vendor_revenue_change", "vendor_sales_event", "vendor_sales_baseline", (a, b) => ratio(a - b, b));
  share("registration_completion_rate", "registrations_completed", "registrations_started");
  share("waitlist_conversion_rate", "waitlist_converted", "waitlist");
  perGelen("walk_in_share", "walk_ins", 100);
  put(val("early_bird_share", has("early_bird") ? ratio(sum("early_bird"), platform.validTickets) : null, {
    n: nums("early_bird").length, note: `${sources(["early_bird"])}${has("early_bird") ? " Kayıtlı = geçerli bilet." : ""}` }));
  return out;
}

// ------------------------------------------------------------------------------------------- summaries

export interface DatasetSummary {
  rows: number;
  numbers: { key: string; header: string; label: string; unit: string; n: number; sum: number; mean: number; min: number; max: number }[];
  booleans: { key: string; header: string; label: string; n: number; trueShare: number }[];
  /** Sum per date of up to three numeric columns (dates ascending, at most 400). */
  series: { date: string; values: Record<string, number> }[];
  seriesKeys: string[];
  /** Top groups of the first group column by the first numeric column. */
  breakdown: { group: string; by: string; items: { label: string; value: number; rows: number }[] } | null;
  period: { first: string; last: string } | null;
}

export function summarizeDataset(d: Pick<ConfirmedDataset, "columns" | "rows" | "mapping">): DatasetSummary {
  const role = (key: string) => d.mapping.find((m) => m.key === key)?.role ?? "ignore";
  const idx = (key: string) => d.columns.findIndex((c) => c.key === key);
  const numericCols = d.columns.filter((c) => c.type === "number" && (role(c.key) === "value" || role(c.key).startsWith("measure:")));
  const label = (key: string) => {
    const r = role(key);
    return r.startsWith("measure:") ? MEASURE_BY_KEY.get(r.slice(8))?.label ?? key : d.columns.find((c) => c.key === key)?.header ?? key;
  };
  const numbers = numericCols.map((c) => {
    const xs = d.rows.map((r) => r[idx(c.key)]).filter((v): v is number => typeof v === "number");
    const s = xs.reduce((a, x) => a + x, 0);
    const r = role(c.key);
    return { key: c.key, header: c.header, label: label(c.key), unit: r.startsWith("measure:") ? MEASURE_BY_KEY.get(r.slice(8))?.unit ?? "" : "",
      n: xs.length, sum: s, mean: xs.length ? s / xs.length : 0, min: xs.length ? Math.min(...xs) : 0, max: xs.length ? Math.max(...xs) : 0 };
  }).filter((x) => x.n > 0);
  const booleans = d.columns.filter((c) => c.type === "boolean" && role(c.key).startsWith("measure:")).map((c) => {
    const xs = d.rows.map((r) => r[idx(c.key)]).filter((v): v is boolean => typeof v === "boolean");
    return { key: c.key, header: c.header, label: label(c.key), n: xs.length, trueShare: xs.length ? (xs.filter(Boolean).length / xs.length) * 100 : 0 };
  }).filter((x) => x.n > 0);

  const dateCol = d.columns.find((c) => role(c.key) === "date");
  const seriesKeys = numbers.slice(0, 3).map((x) => x.key);
  let series: DatasetSummary["series"] = [];
  let period: DatasetSummary["period"] = null;
  if (dateCol) {
    const di = idx(dateCol.key);
    const map = new Map<string, Record<string, number>>();
    for (const r of d.rows) {
      const date = typeof r[di] === "string" ? (r[di] as string).slice(0, 10) : null;
      if (!date) continue;
      const rec = map.get(date) ?? map.set(date, {}).get(date)!;
      for (const k of seriesKeys) {
        const v = r[idx(k)];
        if (typeof v === "number") rec[k] = (rec[k] ?? 0) + v;
      }
    }
    series = [...map].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 400).map(([date, values]) => ({ date, values }));
    if (series.length) period = { first: series[0]!.date, last: series.at(-1)!.date };
  }
  const groupCol = d.columns.find((c) => role(c.key) === "group");
  let breakdown: DatasetSummary["breakdown"] = null;
  if (groupCol && numbers.length) {
    const gi = idx(groupCol.key), vi = idx(numbers[0]!.key);
    const agg = new Map<string, { value: number; rows: number }>();
    for (const r of d.rows) {
      const g = r[gi];
      if (g === null || g === undefined) continue;
      const a = agg.get(String(g)) ?? agg.set(String(g), { value: 0, rows: 0 }).get(String(g))!;
      a.rows++;
      if (typeof r[vi] === "number") a.value += r[vi] as number;
    }
    breakdown = { group: groupCol.header, by: numbers[0]!.label,
      items: [...agg].sort((a, b) => b[1].value - a[1].value).slice(0, 10).map(([labelText, a]) => ({ label: labelText.slice(0, 80), ...a })) };
  }
  return { rows: d.rows.length, numbers, booleans, series, seriesKeys, breakdown, period };
}
