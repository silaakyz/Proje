/**
 * The organization's own tables for an event (event_datasets): upload (Excel .xlsx or CSV), column mapping
 * (rule-based, optionally improved by a model that sees column statistics only — never raw rows), confirmation by a
 * person, and a written interpretation of the computed figures. Only CONFIRMED tables feed metrics and reports.
 *
 * Privacy: columns that look like names, e-mail addresses, phone or national id numbers are removed before
 * anything is stored or sent to a model; the uploader is told which ones.
 */
import "server-only";
import { createHash } from "node:crypto";
import { generateText, Output } from "ai";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/db";
import { attendees, eventDatasets, events } from "@/db/schema";
import { parseCsv } from "@/lib/connectors/csv";
import { MEASURE_BY_KEY, MEASURES, proposeMapping, validateMapping, type ColumnMapping, type Role } from "@/lib/datasets/measures";
import { buildTable, type Column, type Value } from "@/lib/datasets/table";
import { KPI_BY_ID } from "@/lib/kpi/catalog";
import { computeDatasetKpis, summarizeDataset, type ConfirmedDataset } from "@/lib/kpi/datasets";
import { formatKpiValue } from "@/lib/ui/format";
import { AI_TASKS, assertAiConfigured, modelFor } from "@/server/ai/models";
import type { OrgAccess } from "@/server/auth/org-access";
import { ApiError } from "@/server/http";
import { finishGeneration, startGeneration } from "@/server/logistics/ai-generations-drizzle";
import { readXlsx, WorkbookError, type Cell } from "./xlsx";

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

export const aiAvailable = () => {
  try {
    assertAiConfigured();
    return true;
  } catch {
    return false;
  }
};

async function eventOf(organizationId: string, eventId: string) {
  const [ev] = await adminDb.select({ id: events.id, title: events.title, aiConfig: events.aiConfig }).from(events)
    .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId))).limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  return ev;
}

// ------------------------------------------------------------------------------------------- upload

export const uploadDatasetSchema = z.object({
  organizationId: z.uuid(),
  fileName: z.string().trim().min(1).max(255),
  /** File content, base64. */
  content: z.string().min(1).max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8),
  /** Sheet to read; default: the first sheet with data. */
  sheet: z.string().max(120).nullable().default(null),
  name: z.string().trim().min(1).max(200).nullable().default(null),
});

function readSheets(fileName: string, buf: Buffer): { name: string; rows: Cell[][]; truncated: boolean }[] {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "xls") throw new ApiError(422, "Excel 97–2003 (.xls) is not supported", "DATASET_XLS");
  if (ext === "csv" || ext === "txt") {
    const text = buf.toString("utf8");
    return [{ name: "CSV", rows: parseCsv(text) as Cell[][], truncated: false }];
  }
  if (ext !== "xlsx" && ext !== "xlsm") throw new ApiError(422, "Only .xlsx and .csv files are read", "DATASET_TYPE");
  try {
    return readXlsx(buf);
  } catch (e) {
    if (e instanceof WorkbookError) throw new ApiError(422, e.message, "DATASET_UNREADABLE");
    throw e;
  }
}

export async function uploadDataset(access: OrgAccess, eventId: string, input: z.infer<typeof uploadDatasetSchema>) {
  const ev = await eventOf(access.organizationId, eventId);
  const buf = Buffer.from(input.content, "base64");
  if (buf.length > MAX_UPLOAD_BYTES) throw new ApiError(413, "File too large", "DATASET_TOO_LARGE");
  const sheets = readSheets(input.fileName, buf);
  const sheet = input.sheet
    ? sheets.find((s) => s.name === input.sheet)
    : sheets.find((s) => s.rows.filter((r) => r.some((c) => c !== null && c !== "")).length >= 2) ?? sheets[0];
  if (!sheet) throw new ApiError(422, "Sheet not found", "DATASET_SHEET");
  let table;
  try {
    table = buildTable(sheet.rows);
  } catch (e) {
    throw new ApiError(422, (e as Error).message, "DATASET_NO_TABLE");
  }
  if (!table.columns.length) throw new ApiError(422, "No usable columns", "DATASET_NO_TABLE");
  let mapping = proposeMapping(table.columns, table.rows.length);
  let suggestedBy: Record<string, unknown> | null = null;
  let title: string | null = null;
  const notes: string[] = [];
  if (aiAvailable()) {
    try {
      const s = await suggestWithModel(access, eventId, ev.title, table.columns, mapping, table.rows.length);
      mapping = s.mapping;
      suggestedBy = s.by;
      title = s.title;
    } catch {
      notes.push("Yapay zekâ önerisi alınamadı; sütun eşleştirmesi başlık kurallarıyla yapıldı.");
    }
  }
  const base = input.fileName.replace(/\.[^.]+$/, "");
  const name = (input.name ?? title ?? (sheets.length > 1 ? `${base} · ${sheet.name}` : base)).slice(0, 200);
  const [row] = await adminDb.insert(eventDatasets).values({
    organizationId: access.organizationId, eventId, name, fileName: input.fileName.slice(0, 255), sheetName: sheet.name.slice(0, 120),
    columns: table.columns, rows: table.rows, rowCount: table.rows.length, headerRow: table.headerRow,
    droppedColumns: table.droppedColumns, mapping, suggestedBy, createdBy: access.userId,
  }).returning({ id: eventDatasets.id });
  if (table.totalRowsRemoved) notes.push(`${table.totalRowsRemoved} "Toplam" satırı iki kez sayılmasın diye alınmadı.`);
  if (sheet.truncated) notes.push("Sayfa satır veya sütun sınırını aşıyor; fazlası okunmadı (en fazla 20.000 satır, 100 sütun).");
  return {
    id: row!.id, sheets: sheets.map((s) => s.name), sheet: sheet.name, rows: table.rows.length, columns: table.columns.length,
    droppedColumns: table.droppedColumns, notes,
  };
}

// ------------------------------------------------------------------------------------------- model suggestions

const ROLE_VALUES = ["date", "group", "value", "ignore", ...MEASURES.map((m) => `measure:${m.key}`)] as const;
const suggestionSchema = z.object({
  title: z.string().max(80),
  columns: z.array(z.object({ key: z.string(), role: z.enum(ROLE_VALUES), reason: z.string().max(200) })),
});

const SUGGEST_SYSTEM = [
  "Bir etkinlik kurumunun yüklediği tablonun sütunlarının ne anlama geldiğini belirliyorsun. Yalnızca sütun adları ve özet istatistikler veriliyor.",
  "Her sütun için bir rol seç:",
  "- date: satırın tarihi; group: değerleri gruplamak için etiket (oturum, stant, gün, alan); value: başka bir sayı (özetlenir, metrik beslemez); ignore: kullanılmaz;",
  "- measure:<anahtar>: sütun aşağıdaki ölçülerden biriyse. Bir ölçüyü yalnızca anlamı açıkça uyuyorsa seç; emin değilsen value veya ignore seç. Bir ölçü en fazla bir sütuna atanır.",
  "Ölçü türü sütun türüyle uyuşmalı (number ölçü → number sütun, boolean ölçü → boolean sütun); date rolü yalnızca date sütunlara.",
  "Ölçüler:",
  ...MEASURES.map((m) => `- measure:${m.key} (${m.type}) — ${m.label}: ${m.description}`),
  "title: tabloya kısa Türkçe bir ad ver (en fazla 60 karakter). reason: seçimin kısa Türkçe gerekçesi.",
].join("\n");

async function suggestWithModel(access: OrgAccess, eventId: string, eventTitle: string, columns: readonly Column[], rules: ColumnMapping[], rowCount: number) {
  const task = AI_TASKS.dataAnalysis;
  const prompt = JSON.stringify({
    event: eventTitle, rows: rowCount,
    columns: columns.map((c) => ({ key: c.key, header: c.header, type: c.type, nonEmpty: c.nonEmpty, distinct: c.distinct, stats: c.stats })),
  });
  const startedAt = Date.now();
  const generationId = await startGeneration(access, {
    eventId, kind: "dataset_mapping", prompt, schemaVersion: "dataset-mapping/1", provider: task.provider, model: task.modelId, temperature: task.temperature,
  });
  try {
    const r = await generateText({ model: modelFor("dataAnalysis"), temperature: task.temperature, maxOutputTokens: task.maxOutputTokens,
      system: SUGGEST_SYSTEM, prompt, output: Output.object({ schema: suggestionSchema, name: "column_mapping" }) });
    await finishGeneration(access, generationId, { status: "SUCCEEDED", output: r.output, latencyMs: Date.now() - startedAt,
      inputTokens: r.totalUsage.inputTokens, outputTokens: r.totalUsage.outputTokens });
    // A suggestion is kept only where it is valid for that column; a header-rule measure match is not overridden.
    const used = new Set(rules.filter((m) => m.role.startsWith("measure:")).map((m) => m.role));
    const mapping = rules.map((rule) => {
      const s = r.output.columns.find((x) => x.key === rule.key);
      if (!s || rule.role.startsWith("measure:") || s.role === rule.role) return rule;
      if (s.role.startsWith("measure:") && used.has(s.role as Role)) return rule;
      const candidate: ColumnMapping = { key: rule.key, role: s.role as Role, source: "ai", note: s.reason.slice(0, 200) };
      if (validateMapping(columns, [candidate]).length) return rule;
      if (s.role.startsWith("measure:")) used.add(s.role as Role);
      return candidate;
    });
    return { mapping, title: r.output.title.trim() || null, by: { model: task.modelId, at: new Date().toISOString(), generationId } };
  } catch (e) {
    await finishGeneration(access, generationId, { status: "FAILED_PROVIDER", errors: { message: (e as Error).message }, latencyMs: Date.now() - startedAt }).catch(() => {});
    throw e;
  }
}

// ------------------------------------------------------------------------------------------- read

type Row = typeof eventDatasets.$inferSelect;
const asConfirmed = (r: Row): ConfirmedDataset => ({
  id: r.id, name: r.name, columns: r.columns as Column[], rows: r.rows as Value[][], mapping: r.mapping as ColumnMapping[],
});

/** Datasets of an event with their summaries (no rows). */
export async function listDatasets(organizationId: string, eventId: string) {
  await eventOf(organizationId, eventId);
  const rows = await adminDb.select().from(eventDatasets)
    .where(and(eq(eventDatasets.organizationId, organizationId), eq(eventDatasets.eventId, eventId))).orderBy(asc(eventDatasets.createdAt));
  return rows.map((r) => {
    const d = asConfirmed(r);
    const summary = summarizeDataset(d);
    const interp = r.interpretation as { text?: string; model?: string; at?: string; basis?: string } | null;
    return {
      id: r.id, name: r.name, fileName: r.fileName, sheetName: r.sheetName, status: r.status as "NEEDS_REVIEW" | "CONFIRMED",
      rowCount: r.rowCount, columns: d.columns, mapping: d.mapping, droppedColumns: r.droppedColumns, suggestedBy: r.suggestedBy,
      summary, confirmedAt: r.confirmedAt, createdAt: r.createdAt,
      interpretation: interp?.text ? { text: interp.text, model: interp.model ?? null, at: interp.at ?? null, stale: interp.basis !== basisOf(d) } : null,
    };
  });
}

/** First rows of a dataset for the mapping review (data.manage). */
export async function datasetPreview(organizationId: string, datasetId: string) {
  const r = await rowOf(organizationId, datasetId);
  return { id: r.id, name: r.name, status: r.status, columns: r.columns as Column[], mapping: r.mapping as ColumnMapping[], rows: (r.rows as Value[][]).slice(0, 15) };
}

async function rowOf(organizationId: string, datasetId: string) {
  const [r] = await adminDb.select().from(eventDatasets)
    .where(and(eq(eventDatasets.id, datasetId), eq(eventDatasets.organizationId, organizationId))).limit(1);
  if (!r) throw new ApiError(404, "Dataset not found");
  return r;
}

/** Confirmed datasets of an event, for the KPI engine and the report context. */
export async function loadConfirmedDatasets(organizationId: string, eventId: string): Promise<ConfirmedDataset[]> {
  const rows = await adminDb.select().from(eventDatasets)
    .where(and(eq(eventDatasets.organizationId, organizationId), eq(eventDatasets.eventId, eventId), eq(eventDatasets.status, "CONFIRMED")))
    .orderBy(asc(eventDatasets.createdAt));
  return rows.map(asConfirmed);
}

// ------------------------------------------------------------------------------------------- confirm, delete

const roleSchema = z.string().refine((r) => (ROLE_VALUES as readonly string[]).includes(r), "unknown role");
export const confirmDatasetSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  mapping: z.array(z.object({ key: z.string().max(200), role: roleSchema })).max(200),
});

export async function confirmDataset(access: OrgAccess, datasetId: string, input: z.infer<typeof confirmDatasetSchema>) {
  const r = await rowOf(access.organizationId, datasetId);
  const columns = r.columns as Column[];
  const current = r.mapping as ColumnMapping[];
  const mapping: ColumnMapping[] = columns.map((c) => {
    const sent = input.mapping.find((m) => m.key === c.key);
    const cur = current.find((m) => m.key === c.key);
    if (!sent) return cur ?? { key: c.key, role: "ignore", source: "user" };
    return sent.role === cur?.role ? cur : { key: c.key, role: sent.role as Role, source: "user" };
  });
  const errors = validateMapping(columns, mapping);
  if (errors.length) throw new ApiError(422, `Eşleştirme geçersiz: ${errors.join("; ")}`, "DATASET_MAPPING");
  await adminDb.update(eventDatasets).set({
    mapping, name: input.name ?? r.name, status: "CONFIRMED", confirmedBy: access.userId, confirmedAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(eventDatasets.id, datasetId), eq(eventDatasets.organizationId, access.organizationId)));
  return { id: datasetId, status: "CONFIRMED" as const };
}

export async function deleteDataset(organizationId: string, datasetId: string) {
  const [r] = await adminDb.delete(eventDatasets)
    .where(and(eq(eventDatasets.id, datasetId), eq(eventDatasets.organizationId, organizationId))).returning({ id: eventDatasets.id });
  if (!r) throw new ApiError(404, "Dataset not found");
}

// ------------------------------------------------------------------------------------------- interpretation

/** Fingerprint of what an interpretation was written from (mapping + values): a changed table makes it stale. */
const basisOf = (d: ConfirmedDataset) => createHash("sha256").update(JSON.stringify([d.mapping.map((m) => [m.key, m.role]), d.rows.length, summarizeDataset(d)])).digest("hex").slice(0, 16);

const INTERPRET_SYSTEM = [
  "Bir etkinlik kurumunun kendi verisinden hesaplanan rakamları yorumluyorsun. Türkçe, kısa ve somut yaz.",
  "Kurallar: yalnızca verilen rakamları kullan; yeni sayı, oran veya kıyas uydurma; hesaplama yapman gerekiyorsa verilen rakamlardan yap ve nasıl yaptığını söyle.",
  "Bir metrik hesaplanamadıysa nedenini (eksik veri) söyle. Veri sınırlılıklarını (satır sayısı, eksik hücre, tek gün vb.) belirt.",
  "Biçim: 3–6 madde; her madde '- ' ile başlar. Sonda 'Öneri:' ile başlayan tek cümle. Toplam 1200 karakteri geçme.",
].join("\n");

export async function interpretDataset(access: OrgAccess, datasetId: string) {
  assertAiConfigured();
  const r = await rowOf(access.organizationId, datasetId);
  const [att] = await adminDb.select({
    checkedIn: sql<number>`count(*) filter (where ${attendees.isCheckedIn})::int`, valid: sql<number>`count(*)::int`,
  }).from(attendees).where(and(eq(attendees.organizationId, access.organizationId), eq(attendees.eventId, r.eventId), isNull(attendees.cancelledAt)));
  const checkedIn = Number(att?.checkedIn ?? 0), validTickets = Number(att?.valid ?? 0);
  if (r.status !== "CONFIRMED") throw new ApiError(409, "Confirm the column mapping first", "DATASET_NOT_CONFIRMED");
  const ev = await eventOf(access.organizationId, r.eventId);
  const d = asConfirmed(r);
  const summary = summarizeDataset(d);
  // metrics this table contributes to (computed from this table alone)
  const metrics = computeDatasetKpis([d], { checkedIn, validTickets }).filter((m) => (m.n ?? 0) > 0 || m.value !== null);
  const facts = {
    etkinlik: ev.title, tablo: d.name, satir: summary.rows, donem: summary.period,
    sayisal_sutunlar: summary.numbers.map((n) => ({ ad: n.label, birim: n.unit, toplam: n.sum, ortalama: Number(n.mean.toFixed(2)), en_az: n.min, en_cok: n.max, dolu_hucre: n.n })),
    evet_hayir: summary.booleans.map((b) => ({ ad: b.label, evet_payi_yuzde: Number(b.trueShare.toFixed(1)), n: b.n })),
    gruplar: summary.breakdown ? { grup: summary.breakdown.group, olcu: summary.breakdown.by, ilk10: summary.breakdown.items } : null,
    gunluk_seri: summary.series.length > 1 ? summary.series.slice(0, 60) : undefined,
    metrikler: metrics.map((m) => ({ ad: KPI_BY_ID.get(m.id)?.name ?? m.id, formul: KPI_BY_ID.get(m.id)?.formula,
      deger: m.value === null ? null : formatKpiValue(m.value, KPI_BY_ID.get(m.id)?.unit ?? "", m.id), not: m.note })),
    katilim_checkin: checkedIn,
  };
  const prompt = JSON.stringify(facts);
  const task = AI_TASKS.dataAnalysis;
  const startedAt = Date.now();
  const generationId = await startGeneration(access, {
    eventId: r.eventId, kind: "dataset_interpretation", prompt, schemaVersion: "dataset-interpretation/1", provider: task.provider, model: task.modelId,
    temperature: task.temperature,
  });
  try {
    const out = await generateText({ model: modelFor("dataAnalysis"), temperature: task.temperature, maxOutputTokens: task.maxOutputTokens, system: INTERPRET_SYSTEM, prompt });
    const text = out.text.trim().slice(0, 2000);
    await finishGeneration(access, generationId, { status: "SUCCEEDED", output: { text }, latencyMs: Date.now() - startedAt,
      inputTokens: out.totalUsage.inputTokens, outputTokens: out.totalUsage.outputTokens });
    const interpretation = { text, model: task.modelId, at: new Date().toISOString(), generationId, basis: basisOf(d) };
    await adminDb.update(eventDatasets).set({ interpretation, updatedAt: new Date() })
      .where(and(eq(eventDatasets.id, datasetId), eq(eventDatasets.organizationId, access.organizationId)));
    return { text, model: task.modelId, at: interpretation.at };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    await finishGeneration(access, generationId, { status: "FAILED_PROVIDER", errors: { message }, latencyMs: Date.now() - startedAt }).catch(() => {});
    const quota = /\b429\b|quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(message);
    throw new ApiError(quota ? 429 : 502, quota ? "AI quota exceeded" : "AI provider error", quota ? "AI_QUOTA" : "AI_PROVIDER_ERROR");
  }
}

/** Plain-text lines about the confirmed datasets for the assistant / report context. */
export async function datasetsContext(organizationId: string, eventId: string) {
  const rows = await adminDb.select().from(eventDatasets)
    .where(and(eq(eventDatasets.organizationId, organizationId), eq(eventDatasets.eventId, eventId), eq(eventDatasets.status, "CONFIRMED")))
    .orderBy(asc(eventDatasets.createdAt));
  return rows.map((r) => {
    const d = asConfirmed(r);
    const s = summarizeDataset(d);
    const nums = s.numbers.slice(0, 8).map((n) => `${n.label}: toplam ${round(n.sum)}${n.unit ? ` ${n.unit}` : ""}, ortalama ${round(n.mean)}, en az ${round(n.min)}, en çok ${round(n.max)}`);
    const interp = (r.interpretation as { text?: string } | null)?.text;
    return [
      `Kurum verisi "${r.name}" (${r.fileName}, ${s.rows} satır${s.period ? `, ${s.period.first} – ${s.period.last}` : ""}):`,
      ...nums.map((x) => `  - ${x}`),
      ...(s.breakdown ? [`  - ${s.breakdown.group} kırılımı (${s.breakdown.by}): ${s.breakdown.items.slice(0, 5).map((i) => `${i.label} ${round(i.value)}`).join(", ")}`] : []),
      ...(interp ? [`  Yorum (yapay zekâ, ${r.name}): ${interp.replace(/\s+/g, " ").slice(0, 800)}`] : []),
    ].join("\n");
  });
}

const round = (n: number) => (Math.abs(n) >= 10_000 ? Math.round(n) : Math.round(n * 100) / 100).toLocaleString("tr-TR");

export const measureLabel = (key: string) => MEASURE_BY_KEY.get(key)?.label ?? key;
