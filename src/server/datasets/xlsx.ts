/**
 * Minimal, dependency-free reader for Excel workbooks (.xlsx, Office Open XML): a ZIP archive of XML parts.
 * Reads the visible sheets' cell values — shared and inline strings, numbers, booleans, cached formula results — and
 * turns date-formatted numbers into ISO dates using the workbook's styles. No formulas are evaluated, no macros or
 * external links are followed. Limits guard against oversized and "zip bomb" files.
 *
 * Excel 97–2003 (.xls) is a different binary format and is refused with a clear message.
 */
import { inflateRawSync } from "node:zlib";

export type Cell = string | number | boolean | null;
export interface Sheet { name: string; rows: Cell[][]; truncated: boolean }

export class WorkbookError extends Error {}

export const XLSX_LIMITS = { maxEntryBytes: 60 * 1024 * 1024, maxTotalBytes: 150 * 1024 * 1024, maxRows: 20_000, maxCols: 100, maxSheets: 20 };

// ------------------------------------------------------------------------------------------- zip

interface Entry { name: string; method: number; compressedSize: number; size: number; offset: number }

function readZip(buf: Buffer): Map<string, Entry> {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0) {
      throw new WorkbookError("Bu dosya eski Excel 97–2003 (.xls) biçiminde. Excel'de \"Farklı Kaydet → Excel Çalışma Kitabı (.xlsx)\" ile kaydedip yükleyin.");
    }
    throw new WorkbookError("Dosya bir Excel çalışma kitabı (.xlsx) değil.");
  }
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new WorkbookError("Excel dosyası bozuk (ZIP dizini bulunamadı).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new WorkbookError("Excel dosyası bozuk (ZIP girdisi okunamadı).");
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { name, method: buf.readUInt16LE(p + 10), compressedSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(buf: Buffer, e: Entry, budget: { left: number }): string {
  if (e.size > XLSX_LIMITS.maxEntryBytes || e.size > budget.left) throw new WorkbookError("Excel dosyası çok büyük (açıldığında sınırı aşıyor).");
  const h = e.offset;
  if (buf.readUInt32LE(h) !== 0x04034b50) throw new WorkbookError("Excel dosyası bozuk (yerel başlık).");
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  let out: Buffer;
  if (e.method === 0) out = Buffer.from(data);
  else if (e.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.min(XLSX_LIMITS.maxEntryBytes, budget.left) + 1 });
    } catch {
      throw new WorkbookError("Excel dosyası açılamadı (bozuk veya çok büyük).");
    }
  } else throw new WorkbookError(`Desteklenmeyen sıkıştırma (${e.method}); dosyayı Excel'de yeniden kaydedin.`);
  budget.left -= out.length;
  if (budget.left < 0) throw new WorkbookError("Excel dosyası açıldığında çok büyük.");
  return out.toString("utf8");
}

// ------------------------------------------------------------------------------------------- xml

const decode = (s: string) => s
  .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9A-Fa-f]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
/** Text of every <t> in a fragment, skipping phonetic runs. */
const texts = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => decode(m[1] ?? "")).join("");

const AGGREGATE = /^\s*(_xlfn\.)?(SUM|SUMIF|SUMIFS|AVERAGE|AVERAGEIF|SUBTOTAL|AGGREGATE|COUNT|COUNTA|COUNTIF|MIN|MAX|MEDIAN|TOPLA|ORTALAMA|ALTTOPLAM|BAĞ_DEĞ_SAY)\s*\(/i;
const DATE_BUILTIN = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function isDateFormat(code: string) {
  const plain = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[ymdhs]/i.test(plain) && !/^[#0.,%\s]*$/.test(plain);
}

function serialToIso(serial: number, date1904: boolean) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return serial;
  const iso = d.toISOString();
  return Math.abs(serial % 1) < 1e-9 ? iso.slice(0, 10) : iso.slice(0, 16);
}

const colIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// ------------------------------------------------------------------------------------------- workbook

export function readXlsx(buf: Buffer): Sheet[] {
  const zip = readZip(buf);
  const budget = { left: XLSX_LIMITS.maxTotalBytes };
  const part = (name: string) => {
    const e = zip.get(name);
    return e ? extract(buf, e, budget) : null;
  };
  const workbook = part("xl/workbook.xml");
  if (!workbook) throw new WorkbookError("Çalışma kitabında sayfa bulunamadı.");
  const date1904 = /<workbookPr[^>]*\bdate1904="(1|true)"/.test(workbook);
  const rels = new Map<string, string>();
  for (const m of (part("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), target = attr(m[0], "Target");
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const shared = [...(part("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => texts(m[1] ?? ""));
  const styles = part("xl/styles.xml") ?? "";
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId")), code = attr(m[0], "formatCode");
    if (Number.isFinite(id) && code !== undefined) custom.set(id, decode(code));
  }
  const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*\/?>/g)].map((m) => {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    return DATE_BUILTIN.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!));
  });

  const sheets: Sheet[] = [];
  for (const m of [...workbook.matchAll(/<sheet\b[^>]*\/?>/g)].slice(0, XLSX_LIMITS.maxSheets)) {
    const tag = m[0];
    if (attr(tag, "state") === "hidden" || attr(tag, "state") === "veryHidden") continue;
    const name = decode(attr(tag, "name") ?? "Sayfa");
    const target = rels.get(attr(tag, "r:id") ?? "");
    const xml = target ? part(target) : null;
    if (!xml) continue;
    const rows: Cell[][] = [];
    let truncated = false;
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const rowNum = Number(attr(r[1] ?? r[3] ?? "", "r")) || rows.length + 1;
      if (rowNum > XLSX_LIMITS.maxRows + 1) { truncated = true; break; }
      const row: Cell[] = [];
      for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1]!, body = c[2] ?? "";
        const ref = attr(a, "r");
        const idx = ref ? colIndex(ref) : row.length;
        if (idx >= XLSX_LIMITS.maxCols) { truncated = true; continue; }
        const t = attr(a, "t"), s = Number(attr(a, "s") ?? 0);
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const formula = body.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1] ?? "";
        let value: Cell = null;
        // A total under a table (SUM, AVERAGE, SUBTOTAL …) would be counted twice: it is skipped.
        if (AGGREGATE.test(formula)) value = null;
        else if (v === "" || v === undefined && t !== "inlineStr") value = null;
        else if (t === "s") value = v !== undefined ? shared[Number(v)] ?? null : null;
        else if (t === "inlineStr") value = texts(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "");
        else if (t === "str") value = v !== undefined ? decode(v) : null;
        else if (t === "b") value = v === "1";
        else if (t === "e") value = null;
        else if (v !== undefined) {
          const n = Number(v);
          value = Number.isFinite(n) ? (dateStyle[s] ? serialToIso(n, date1904) : n) : decode(v);
        }
        row[idx] = typeof value === "string" ? value.trim() : value;
      }
      while (rows.length < rowNum - 1) rows.push([]); // keep blank rows in place
      rows.push(Array.from({ length: row.length }, (_, i) => row[i] ?? null));
    }
    sheets.push({ name, rows, truncated });
  }
  if (!sheets.length) throw new WorkbookError("Çalışma kitabında görünür sayfa yok.");
  return sheets;
}
