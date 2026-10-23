/** Turkish formats from the design system: decimal comma, thousands dot, "17 Eki 2026", "18.42". */
const nf = new Intl.NumberFormat("tr-TR");
const nf1 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const TZ = "Europe/Istanbul";
const dShort = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", timeZone: TZ });
const dLong = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });
const tf = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "—" : nf.format(n));
export const formatDecimal = (n: number | null | undefined) => (n === null || n === undefined ? "—" : nf2.format(n));

/** "%65,8" */
export const formatPercent = (part: number, whole: number) => (whole > 0 ? `%${nf1.format((part / whole) * 100)}` : "%0");
export const ratio = (part: number, whole: number) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0);

/** TRY amounts: "₺ 12,4 mn" above a million, "₺ 2.480" below. */
const nfMoney = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Exact TRY amount for budgets: "₺ 12.500,00" (formatTry rounds to millions). */
export const formatMoney = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? "—" : `₺ ${nfMoney.format(v)}`);

export function formatTry(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (Math.abs(v) >= 1_000_000_000) return `₺ ${nf1.format(v / 1_000_000_000)} mr`;
  if (Math.abs(v) >= 1_000_000) return `₺ ${nf1.format(v / 1_000_000)} mn`;
  return `₺ ${nf.format(Math.round(v))}`;
}

const calendarDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
};

/** YYYY-MM-DD (a calendar date) → "17 Eki 2026"; `short` → "17 Eki". */
export function formatDate(iso: string | null | undefined, short = false) {
  if (!iso) return "Tarih yok";
  return (short ? dShort : dLong).format(calendarDate(iso));
}

export function formatDateRange(start: string | null, end: string | null) {
  if (!start) return "Tarih belirlenmedi";
  if (!end || end === start) return formatDate(start);
  const s = calendarDate(start);
  const e = calendarDate(end);
  if (s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth())
    return `${s.getUTCDate()}–${formatDate(end)}`;
  return `${formatDate(start, s.getUTCFullYear() === e.getUTCFullYear())} – ${formatDate(end)}`;
}

/** A timestamp → "19 Eki 2026 · 18.42" (Istanbul time). */
export function formatDateTime(ts: string | null | undefined, withYear = true) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${(withYear ? dLong : dShort).format(d)} · ${tf.format(d).replace(":", ".")}`;
}

export const formatTime = (ts: string | null | undefined) => (ts ? tf.format(new Date(ts)).replace(":", ".") : "—");

/** Today in Istanbul as YYYY-MM-DD. */
export function todayIso() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parts;
}

/** Whole days from today to an ISO date (negative = past). */
export function daysUntil(iso: string) {
  return Math.round((calendarDate(iso).getTime() - calendarDate(todayIso()).getTime()) / 86_400_000);
}

/** Short printed ticket number derived from the ticket id: "EIP-7F3K2A9C". */
export const ticketCode = (attendeeId: string) => `EIP-${attendeeId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

/** "1.250,5" or "1250.5" → 1250.5; empty → null; invalid → NaN. */
export function parseTrNumber(v: string): number | null {
  const s = v.trim().replace(/\s/g, "");
  if (!s) return null;
  const normalised = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, "") : s;
  return /^-?\d+(\.\d+)?$/.test(normalised) ? Number(normalised) : NaN;
}

/** A KPI engine value in its catalog unit: "%65,8", "₺ 2.480", "4,2 / 5", "NPS 40", "3,5 gün". */
export function formatKpiValue(value: number | null | undefined, unit: string, id = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  switch (unit) {
    case "%": return `%${nf1.format(value)}`;
    case "TRY": return formatTry(value);
    case "score": return id.startsWith("nps") ? nf1.format(value) : `${nf2.format(value)} / 5`;
    case "count":
    case "persons": return nf.format(Math.round(value));
    case "days": return `${nf1.format(value)} gün`;
    case "nights": return `${nf1.format(value)} gece`;
    case "minutes": return `${nf1.format(value)} dk`;
    case "kg": return `${nf2.format(value)} kg`;
    case "kgCO2e": return `${nf2.format(value)} kg CO₂e`;
    case "ugm3": return `${nf1.format(value)} µg/m³`;
    case "index": return id === "air_quality_worst_level" ? `${nf.format(Math.round(value))} / 6` : nf2.format(value);
    default: return nf2.format(value);
  }
}
