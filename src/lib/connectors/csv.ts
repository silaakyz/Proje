/**
 * Sponsor and lead lists uploaded as CSV (Excel "CSV UTF-8" with ";" or "," separators). Pure parsing and
 * validation; an upload is all-or-nothing (any invalid row → nothing is stored, every problem is listed).
 *
 * Personal data: lead lists are pseudonymous. Columns that look like a name, e-mail, phone or national id are
 * dropped before validation and reported back, so they never reach the server's storage.
 */
export const SPONSOR_COLUMNS = ["sponsor", "bu_edisyon", "onceki_edisyon", "maliyet_tl", "atfedilen_deger_tl", "gosterim"] as const;
export const LEAD_COLUMNS = ["lead_id", "stant", "izin", "nitelikli", "firsat", "firsat_degeri_tl", "kazanilan_gelir_tl", "stant_suresi_dk", "tarih"] as const;

export const SPONSOR_TEMPLATE = `${SPONSOR_COLUMNS.join(";")}\r\nÖrnek Sponsor A.Ş.;evet;evet;250000;400000;1200000\r\n`;
export const LEAD_TEMPLATE = `${LEAD_COLUMNS.join(";")}\r\nL-0001;Örnek Yayınevi;evet;evet;hayır;;;12;2026-09-18\r\n`;

const PERSONAL = /^(ad|soyad|ad_soyad|adi|soyadi|isim|name|full_?name|first_?name|last_?name|e_?posta|eposta|email|e_?mail|mail|telefon|tel|gsm|phone|mobile|tc|tckn|tc_kimlik(_no)?|kimlik(_no)?|adres|address)$/;

export const MAX_CSV_ROWS = 5000;

const fold = (s: string) => s.trim().toLocaleLowerCase("tr-TR")
  .replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ö/g, "o").replace(/ç/g, "c")
  .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** RFC 4180-style parsing with "" escapes; the separator is whichever of ; , tab the header line uses most. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", ",", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const YES = new Set(["evet", "e", "yes", "y", "1", "true", "x", "var"]);
const NO = new Set(["hayir", "h", "no", "n", "0", "false", "yok", ""]);
function bool(raw: string): boolean | undefined {
  const f = fold(raw);
  return YES.has(f) ? true : NO.has(f) ? false : undefined;
}
/** "1.234,50" (Turkish), "1234.50", "1 234" → number; "" → null; invalid → undefined. */
function amount(raw: string): number | null | undefined {
  const s = raw.trim().replace(/\s|₺|tl$/gi, "");
  if (!s) return null;
  const normalized = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return undefined;
  const n = Number(normalized);
  return n > 100_000_000_000 ? undefined : n; // the database's ceiling (100 billion TRY)
}

export interface CsvIssue { line: number; message: string }
export interface CsvResult<T> { rows: T[]; issues: CsvIssue[]; droppedColumns: string[]; unknownColumns: string[] }

function table(text: string, known: readonly string[], required: readonly string[]) {
  const all = parseCsv(text);
  const header = (all[0] ?? []).map(fold);
  const dropped = header.filter((h) => PERSONAL.test(h));
  const unknown = header.filter((h) => h && !known.includes(h) && !PERSONAL.test(h));
  const missing = required.filter((r) => !header.includes(r));
  const issues: CsvIssue[] = missing.map((m) => ({ line: 1, message: `"${m}" sütunu yok` }));
  if (all.length - 1 > MAX_CSV_ROWS) issues.push({ line: 1, message: `En fazla ${MAX_CSV_ROWS} satır yüklenebilir` });
  const records = all.slice(1).map((cells, i) => ({
    line: i + 2,
    get: (col: string) => {
      const j = header.indexOf(col);
      return j === -1 ? "" : (cells[j] ?? "").trim();
    },
  }));
  return { records, issues, dropped, unknown };
}

export interface SponsorInput { name: string; currentEdition: boolean; previousEdition: boolean; costKurus: number | null; attributedValueKurus: number | null; impressions: number | null }

export function parseSponsorsCsv(text: string): CsvResult<SponsorInput> {
  const { records, issues, dropped, unknown } = table(text, SPONSOR_COLUMNS, ["sponsor", "bu_edisyon", "onceki_edisyon"]);
  const rows: SponsorInput[] = [];
  if (issues.length) return { rows, issues, droppedColumns: dropped, unknownColumns: unknown };
  for (const r of records) {
    const bad = (m: string) => issues.push({ line: r.line, message: m });
    const name = r.get("sponsor");
    const cur = bool(r.get("bu_edisyon")), prev = bool(r.get("onceki_edisyon"));
    const cost = amount(r.get("maliyet_tl")), value = amount(r.get("atfedilen_deger_tl")), imp = amount(r.get("gosterim"));
    if (!name || name.length > 200) bad("sponsor adı boş veya 200 karakterden uzun");
    if (cur === undefined) bad("bu_edisyon: evet / hayır");
    if (prev === undefined) bad("onceki_edisyon: evet / hayır");
    if (cur === false && prev === false) bad("bu veya önceki edisyondan en az birinde sponsor olmalı");
    if (cost === undefined) bad("maliyet_tl sayı olmalı");
    if (value === undefined) bad("atfedilen_deger_tl sayı olmalı");
    if (imp === undefined || (imp !== null && !Number.isInteger(imp))) bad("gosterim tam sayı olmalı");
    if (cost !== undefined && value !== undefined && imp !== undefined && cur !== undefined && prev !== undefined && name) {
      rows.push({ name: name.slice(0, 200), currentEdition: cur, previousEdition: prev, costKurus: cost === null ? null : Math.round(cost * 100),
        attributedValueKurus: value === null ? null : Math.round(value * 100), impressions: imp });
    }
  }
  return { rows: issues.length ? [] : rows, issues, droppedColumns: dropped, unknownColumns: unknown };
}

export interface LeadInput {
  externalId: string; exhibitor: string | null; consent: boolean; qualified: boolean; opportunity: boolean;
  opportunityValueKurus: number | null; wonRevenueKurus: number | null; boothMinutes: number | null; capturedAt: string | null;
}

export function parseLeadsCsv(text: string): CsvResult<LeadInput> {
  const { records, issues, dropped, unknown } = table(text, LEAD_COLUMNS, ["lead_id", "izin", "nitelikli", "firsat"]);
  const rows: LeadInput[] = [];
  if (issues.length) return { rows, issues, droppedColumns: dropped, unknownColumns: unknown };
  const seen = new Set<string>();
  for (const r of records) {
    const bad = (m: string) => issues.push({ line: r.line, message: m });
    const id = r.get("lead_id");
    const consent = bool(r.get("izin")), qualified = bool(r.get("nitelikli")), opp = bool(r.get("firsat"));
    const oppValue = amount(r.get("firsat_degeri_tl")), won = amount(r.get("kazanilan_gelir_tl")), minutes = amount(r.get("stant_suresi_dk"));
    const date = r.get("tarih");
    if (!id || id.length > 100) bad("lead_id boş veya 100 karakterden uzun");
    else if (/@|\d{10,}/.test(id)) bad("lead_id e-posta veya telefon gibi görünüyor; takma (anonim) bir kimlik kullanın");
    else if (seen.has(id)) bad(`lead_id tekrar ediyor: ${id}`);
    seen.add(id);
    if (consent === undefined) bad("izin: evet / hayır");
    if (qualified === undefined) bad("nitelikli: evet / hayır");
    if (opp === undefined) bad("firsat: evet / hayır");
    if (oppValue === undefined) bad("firsat_degeri_tl sayı olmalı");
    if (opp === false && oppValue) bad("fırsat olmayan satırda fırsat değeri olamaz");
    if (won === undefined) bad("kazanilan_gelir_tl sayı olmalı");
    if (minutes === undefined || (minutes !== null && minutes > 1440)) bad("stant_suresi_dk 0–1440 arasında olmalı");
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) bad("tarih YYYY-AA-GG olmalı");
    if (id && consent !== undefined && qualified !== undefined && opp !== undefined && oppValue !== undefined && won !== undefined && minutes !== undefined) {
      rows.push({ externalId: id.slice(0, 100), exhibitor: r.get("stant").slice(0, 200) || null, consent, qualified, opportunity: opp,
        opportunityValueKurus: oppValue === null ? null : Math.round(oppValue * 100), wonRevenueKurus: won === null ? null : Math.round(won * 100),
        boothMinutes: minutes, capturedAt: date || null });
    }
  }
  return { rows: issues.length ? [] : rows, issues, droppedColumns: dropped, unknownColumns: unknown };
}
