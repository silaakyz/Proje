/**
 * Turns a sheet's raw cells into a typed table: finds the header row, names and types each column, and removes
 * columns that hold personal data (by header or by content) before anything is stored or sent to a model.
 *
 * Types: number (also Turkish "1.234,5" text), date (ISO, dd.mm.yyyy, dd/mm/yyyy), boolean (evet/hayır, yes/no,
 * true/false, x), text. A column takes a type when at least 80 % of its non-empty cells parse as that type.
 */
export type RawCell = string | number | boolean | null;
export type ColumnType = "number" | "date" | "boolean" | "text";
export type Value = number | string | boolean | null;

export interface Column {
  key: string;
  header: string;
  type: ColumnType;
  nonEmpty: number;
  distinct: number;
  /** Numbers: min / max / sum / mean; dates: first / last; text: up to 5 most frequent values (not for free text). */
  stats: { min?: number; max?: number; sum?: number; mean?: number; first?: string; last?: string; top?: { value: string; count: number }[] };
}

export interface Table { columns: Column[]; rows: Value[][]; headerRow: number; droppedColumns: { header: string; reason: string }[]; totalRowsRemoved: number }

export const MAX_TABLE_ROWS = 20_000;
export const MAX_TABLE_COLUMNS = 60;

export const fold = (s: string) => s.trim().toLocaleLowerCase("tr-TR")
  .replace(/ı/g, "i").normalize("NFD").replace(/[\u0300-\u036f]/g, "") // ğ ü ş ö ç â î û → g u s o c a i u
  .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const PERSONAL_HEADER = /^(ad|soyad|adi|soyadi|isim|name|mail|tel|tc|kimlik|kimlik_no)$|(^|_)(ad_?soyad|adi_?soyadi|isim_?soyisim|full_?name|first_?name|last_?name|e_?posta|eposta|email|e_?mail|telefon|gsm|cep_tel(efonu)?|phone|mobile|tckn|tc_?kimlik(_no)?|kimlik_?no|adres|address|iban|dogum_tarihi|birth_?date)(_|$)/;
const TOTAL_LABEL = /^(toplam|genel_toplam|ara_toplam|total|grand_total|subtotal|sum|ortalama|average)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^(\+?90[\s-]?)?0?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}$/;
const TCKN = /^[1-9]\d{10}$/;

const TRUE = new Set(["evet", "e", "yes", "y", "true", "x", "var", "dogru"]);
const FALSE = new Set(["hayir", "h", "no", "n", "false", "yok", "yanlis"]);

export function parseNumber(v: RawCell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/\s|₺|tl$|try$|%$/gi, "");
  if (!s || !/^-?[\d.,]+$/.test(s)) return null;
  if (/,\d{1,3}$/.test(s) && (s.match(/,/g) ?? []).length === 1 && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 1.234,5
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // Turkish thousands: 2.500 → 2500
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseDate(v: RawCell): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/); // Turkish day-first
  if (m) {
    const d = m[1]!.padStart(2, "0"), mo = m[2]!.padStart(2, "0");
    if (Number(mo) > 12 || Number(d) > 31) return null;
    return m[4] ? `${m[3]}-${mo}-${d}T${m[4]!.padStart(2, "0")}:${m[5]}` : `${m[3]}-${mo}-${d}`;
  }
  return null;
}

export function parseBoolean(v: RawCell): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const f = fold(v);
  return TRUE.has(f) ? true : FALSE.has(f) ? false : null;
}

const isEmpty = (v: RawCell) => v === null || (typeof v === "string" && v.trim() === "");

/** The header row: among the first 15 rows, the first one with ≥ 2 text cells that covers most filled columns. */
function findHeader(rows: RawCell[][]) {
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.filter((c) => !isEmpty(c)).length));
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i] ?? [];
    const filled = r.filter((c) => !isEmpty(c));
    const textual = filled.filter((c) => typeof c === "string" && parseNumber(c) === null && parseDate(c) === null);
    if (textual.length >= 2 && textual.length >= filled.length * 0.7 && filled.length >= Math.max(2, width * 0.5)) return i;
  }
  return -1;
}

export function buildTable(raw: RawCell[][]): Table {
  const origin = raw.map((r, i) => (r.some((c) => !isEmpty(c)) ? i : -1)).filter((i) => i >= 0);
  const rowsIn = origin.map((i) => raw[i]!);
  if (rowsIn.length < 2) throw new Error("Sayfada başlık ve en az bir veri satırı yok.");
  const h = findHeader(rowsIn);
  if (h < 0) throw new Error("Başlık satırı bulunamadı: ilk satırlardan biri sütun adlarını içermeli.");
  const header = rowsIn[h]!;
  // "Toplam" rows under a table would be counted twice; they are removed before typing so a label in a date or number
  // column does not change that column's type.
  const isTotal = (r: RawCell[]) => {
    const first = r.find((c) => !isEmpty(c));
    return typeof first === "string" && TOTAL_LABEL.test(fold(first));
  };
  const all = rowsIn.slice(h + 1, h + 1 + MAX_TABLE_ROWS);
  const body = all.filter((r) => !isTotal(r));
  const width = Math.min(Math.max(header.length, ...body.map((r) => r.length)), MAX_TABLE_COLUMNS);

  const seen = new Map<string, number>();
  const columns: Column[] = [];
  const keep: number[] = [];
  const droppedColumns: Table["droppedColumns"] = [];
  for (let j = 0; j < width; j++) {
    const headerText = isEmpty(header[j] ?? null) ? `Sütun ${j + 1}` : String(header[j]).trim().slice(0, 120);
    const cells = body.map((r) => r[j] ?? null).filter((c) => !isEmpty(c));
    if (!cells.length) continue;
    const strings = cells.filter((c): c is string => typeof c === "string");
    const share = (re: RegExp) => (strings.length ? strings.filter((s) => re.test(s.trim())).length / cells.length : 0);
    if (PERSONAL_HEADER.test(fold(headerText))) { droppedColumns.push({ header: headerText, reason: "kişisel veri olabilecek sütun adı" }); continue; }
    if (share(EMAIL) > 0.3 || share(PHONE) > 0.3) { droppedColumns.push({ header: headerText, reason: "e-posta veya telefon içeriyor" }); continue; }
    if (cells.filter((c) => TCKN.test(String(c))).length / cells.length > 0.5 && /kimlik|tc/.test(fold(headerText))) {
      droppedColumns.push({ header: headerText, reason: "kimlik numarası içeriyor" }); continue;
    }
    const n = cells.length;
    const nums = cells.map(parseNumber).filter((x): x is number => x !== null);
    const dates = cells.map((c) => (typeof c === "string" ? parseDate(c) : null)).filter((x): x is string => x !== null);
    const bools = cells.map(parseBoolean).filter((x): x is boolean => x !== null);
    const type: ColumnType = dates.length >= 0.8 * n ? "date" : bools.length >= 0.8 * n && nums.length < 0.8 * n ? "boolean" : nums.length >= 0.8 * n ? "number" : "text";
    let key = fold(headerText) || `sutun_${j + 1}`;
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    if (k) key = `${key}_${k + 1}`;
    const distinct = new Set(cells.map((c) => String(c))).size;
    const stats: Column["stats"] = {};
    if (type === "number" && nums.length) {
      stats.min = Math.min(...nums); stats.max = Math.max(...nums);
      stats.sum = nums.reduce((s, x) => s + x, 0); stats.mean = stats.sum / nums.length;
    } else if (type === "date" && dates.length) {
      const sorted = [...dates].sort();
      stats.first = sorted[0]; stats.last = sorted.at(-1);
    } else if (type === "text" && distinct <= Math.max(20, n * 0.5)) {
      const counts = new Map<string, number>();
      for (const c of cells) counts.set(String(c), (counts.get(String(c)) ?? 0) + 1);
      stats.top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value: value.slice(0, 60), count }));
    }
    columns.push({ key, header: headerText, type, nonEmpty: n, distinct, stats });
    keep.push(j);
  }
  const rows = body.map((r) => keep.map((j, i) => {
    const c = r[j] ?? null;
    if (isEmpty(c)) return null;
    switch (columns[i]!.type) {
      case "number": return parseNumber(c);
      case "date": return typeof c === "string" ? parseDate(c) : null;
      case "boolean": return parseBoolean(c);
      default: return String(c).slice(0, 500);
    }
  })).filter((r) => r.some((v) => v !== null));
  return { columns, rows, headerRow: origin[h]! + 1, droppedColumns, totalRowsRemoved: all.length - body.length };
}
