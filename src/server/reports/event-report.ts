import "server-only";
/**
 * Downloadable event report (PDF). Every number comes from what is recorded: tickets and check-ins, registrations,
 * tasks, KPI values (engine or the organizer's manual entry, labelled), survey response counts, budget totals (only for
 * roles with budget.read) and the latest stored impact run with its data-sufficiency checks. Nothing is estimated here.
 * The optional management summary is the assistant's draft from the Raporlar page, printed as a labelled draft.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { and, count, eq } from "drizzle-orm";
import { adminDb } from "@/db";
import { eventRegistrations, organizations } from "@/db/schema";
import { KPI_BY_ID } from "@/lib/kpi/catalog";
import { formatDate, formatDateRange, formatDateTime, formatDecimal, formatKpiValue, formatNumber, formatPercent, formatTry } from "@/lib/ui/format";
import {
  ATTENDANCE_BASIS_LABEL, AUDIENCE_LABEL, EVENT_STATUS_LABEL, IMPACT_CHECK_LABEL, IMPACT_LEVEL_LABEL, KPI_STATUS_BADGE, metricInfo, SURVEY_STATUS_BADGE,
} from "@/lib/ui/labels";
import type { EventStatus, ImpactLevel, SurveyStatus } from "@/lib/api/types";
import { roleHas, type OrgAccess, type UserDbRunner } from "@/server/auth/org-access";
import { eventKpiActuals } from "@/server/analytics/kpi-service";
import { listImpactRuns } from "@/server/analytics/impact-service";
import { getEventDetail } from "@/server/events/events-service";
import { listBudget } from "@/server/finance/budget-service";
import { listKpis } from "@/server/planning/planning-read";
import { listEventSurveys } from "@/server/surveys/survey-service";

export interface EventReportData {
  organization: string;
  generatedAt: string;
  event: { title: string; status: EventStatus; startDate: string | null; endDate: string | null; city: string | null };
  attendance: { tickets: number; checkedIn: number; cancelled: number; registrations: number };
  tasks: { total: number; done: number };
  kpis: { name: string; status: string; target: string; actual: string; source: string }[];
  surveys: { audience: string; title: string; version: number; status: string; responses: number; target: number | null }[];
  budget: { income: { planned: number | null; actual: number | null }; cost: { planned: number | null; actual: number | null }; net: { planned: number | null; actual: number | null } } | null;
  impact: {
    id: string; createdAt: string; engineVersion: string; requestedLevel: string; achievedLevel: string | null;
    attendance: string | null; sampleSize: number | null;
    figures: { label: string; value: string }[];
    checks: { label: string; passed: boolean }[];
  } | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Collects the report from the stored records (the caller has org.read; budget only with budget.read). */
export async function collectEventReport(access: OrgAccess, runAsUser: UserDbRunner, eventId: string): Promise<EventReportData> {
  const { organizationId } = access;
  const detail = await getEventDetail(runAsUser, organizationId, eventId);
  const finance = roleHas(access.role, "budget.read");
  const [kpis, actuals, surveys, runs, budget, [reg], [org]] = await Promise.all([
    listKpis(runAsUser, organizationId, eventId),
    eventKpiActuals(organizationId, eventId, { finance }),
    listEventSurveys(organizationId, eventId, false),
    listImpactRuns(runAsUser, organizationId, eventId),
    finance ? listBudget(organizationId, eventId) : Promise.resolve(null),
    adminDb.select({ n: count() }).from(eventRegistrations)
      .where(and(eq(eventRegistrations.organizationId, organizationId), eq(eventRegistrations.eventId, eventId))),
    adminDb.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1),
  ]);
  const actualById = new Map(actuals.map((a) => [a.id, a]));
  const taskTotal = Object.values(detail.counts.tasks).reduce((s, n) => s + n, 0);

  const kpiRows = kpis.filter((k) => k.status !== "DROPPED").map((k) => {
    const a = actualById.get(k.id);
    const def = a?.catalogId ? KPI_BY_ID.get(a.catalogId) : undefined;
    const info = metricInfo(k.metricName);
    const actual = a?.actual ?? null;
    return {
      name: def?.name ?? info.name,
      status: KPI_STATUS_BADGE[k.status] ?? k.status,
      target: k.targetValue === null ? "—" : `${formatDecimal(Number(k.targetValue))}${info.unit ? ` ${info.unit}` : ""}`,
      actual: actual === null ? "—" : def ? formatKpiValue(actual, def.unit, def.id) : `${formatDecimal(actual)}${info.unit ? ` ${info.unit}` : ""}`,
      source: a?.actualSource === "engine" ? "Hesaplandı" : a?.actualSource === "manual" ? "Elle girildi" : "Veri yok",
    };
  });

  const latest = runs[0];
  let impact: EventReportData["impact"] = null;
  if (latest) {
    const f = latest.figures;
    const figures = !f ? [] : ([
      ["Brüt doğrudan harcama", f.grossDirectSpend, formatTry],
      ["Atfedilebilir harcama", f.attributableSpend, formatTry],
      ["Toplam çıktı etkisi", f.totalOutputImpact, formatTry],
      ["Katma değer", f.totalValueAdded, formatTry],
      ["Hane gelirleri", f.totalIncome, formatTry],
      ["İstihdam (tam zamanlı eşdeğer)", f.totalEmploymentFte, formatDecimal],
    ] as const).filter(([, v]) => v !== null && v !== undefined).map(([label, v, fmt]) => ({ label, value: fmt(v as number) }));
    const checks = Array.isArray(latest.checks) ? (latest.checks as { check: string; passed: boolean }[]) : [];
    impact = {
      id: latest.id,
      createdAt: new Date(latest.createdAt).toISOString(),
      engineVersion: latest.engineVersion,
      requestedLevel: IMPACT_LEVEL_LABEL[latest.requestedLevel as ImpactLevel] ?? String(latest.requestedLevel),
      achievedLevel: latest.achievedLevel ? IMPACT_LEVEL_LABEL[latest.achievedLevel as ImpactLevel] ?? String(latest.achievedLevel) : null,
      attendance: latest.attendanceUsed === null || latest.attendanceUsed === undefined ? null
        : `${formatNumber(Number(latest.attendanceUsed))}${latest.attendanceBasis ? ` (${ATTENDANCE_BASIS_LABEL[latest.attendanceBasis] ?? latest.attendanceBasis})` : ""}`,
      sampleSize: latest.sampleSize ?? null,
      figures,
      checks: checks.map((c) => ({ label: IMPACT_CHECK_LABEL[c.check] ?? c.check, passed: !!c.passed })),
    };
  }

  return {
    organization: org?.name ?? access.organizationName,
    generatedAt: new Date().toISOString(),
    event: { title: detail.title, status: detail.status, startDate: detail.startDate, endDate: detail.endDate, city: str(detail.profile?.city) },
    attendance: { tickets: detail.counts.attendees.total, checkedIn: detail.counts.attendees.checkedIn, cancelled: detail.counts.attendees.cancelled, registrations: reg?.n ?? 0 },
    tasks: { total: taskTotal, done: detail.counts.tasks.DONE ?? 0 },
    kpis: kpiRows,
    surveys: surveys.map((s) => ({
      audience: AUDIENCE_LABEL[s.audience] ?? s.audience, title: s.title, version: s.version,
      status: SURVEY_STATUS_BADGE[s.status as SurveyStatus] ?? s.status, responses: s.responses, target: s.targetResponses ?? null,
    })),
    budget: budget ? { income: budget.totals.income, cost: budget.totals.cost, net: budget.totals.net } : null,
    impact,
  };
}

// ------------------------------------------------------------------------------------------------------ rendering

const FONT_DIR = path.join(process.cwd(), "src/server/reports/fonts");
let fonts: { regular: Buffer; semibold: Buffer; bold: Buffer } | null = null;
const loadFonts = () => (fonts ??= {
  regular: readFileSync(path.join(FONT_DIR, "Inter-Regular.ttf")),
  semibold: readFileSync(path.join(FONT_DIR, "Inter-SemiBold.ttf")),
  bold: readFileSync(path.join(FONT_DIR, "Inter-Bold.ttf")),
});

const INK = "#1b1d21", MUTED = "#5f6570", LINE = "#d9dce1", ACCENT = "#7a2e1f", PASS = "#2f6b3a", FAIL = "#9a3324";
const M = 50; // page margin (pt)

/** "**x**" / "# x" / "- x" → plain paragraphs, headings and bullets (the assistant writes light Markdown). */
function summaryBlocks(text: string) {
  return text.replace(/\r/g, "").split(/\n{2,}|\n(?=#|[-*•] )/).map((b) => b.trim()).filter(Boolean).map((b) => {
    const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1");
    const h = /^#{1,6}\s+(.*)$/.exec(b);
    if (h) return { kind: "heading" as const, text: clean(h[1]!) };
    if (/^[-*•]\s+/.test(b)) return { kind: "bullets" as const, items: b.split(/\n/).map((l) => clean(l.replace(/^\s*[-*•]\s+/, ""))).filter(Boolean) };
    return { kind: "para" as const, text: clean(b.replace(/\n/g, " ")) };
  });
}

/** Renders the report as an A4 PDF (Inter, page numbers, a draft label on the optional summary). */
export function renderEventReportPdf(data: EventReportData, summary?: string | null): Promise<Buffer> {
  const f = loadFonts();
  const doc = new PDFDocument({
    size: "A4", margins: { top: M, bottom: M + 14, left: M, right: M }, bufferPages: true, font: f.regular as unknown as string,
    info: { Title: `${data.event.title} · Etkinlik raporu`, Author: data.organization, Creator: "EIP" },
    lang: "tr-TR", displayTitle: true,
  } as PDFKit.PDFDocumentOptions);
  doc.registerFont("r", f.regular);
  doc.registerFont("s", f.semibold);
  doc.registerFont("b", f.bold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });

  const W = doc.page.width - 2 * M;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

  const section = (eyebrow: string, title: string) => {
    ensure(70);
    doc.moveDown(1.2);
    doc.font("s").fontSize(8).fillColor(ACCENT).text(eyebrow.toLocaleUpperCase("tr-TR"), M, doc.y);
    doc.moveDown(0.2);
    doc.font("b").fontSize(14).fillColor(INK).text(title, M);
    doc.moveDown(0.5);
  };
  const note = (t: string) => { doc.font("r").fontSize(9).fillColor(MUTED).text(t, M, doc.y, { width: W }); doc.moveDown(0.3); };

  /** A simple table: header row, wrapped cells, repeated header after a page break. */
  const table = (cols: { title: string; width: number; align?: "left" | "right" }[], rows: (string | { text: string; color?: string })[][]) => {
    const widths = cols.map((c) => c.width * W);
    const pad = 4;
    const drawHeader = () => {
      const y = doc.y;
      doc.font("s").fontSize(8).fillColor(MUTED);
      let x = M;
      cols.forEach((c, i) => { doc.text(c.title.toLocaleUpperCase("tr-TR"), x + pad, y, { width: widths[i]! - 2 * pad, align: c.align ?? "left" }); x += widths[i]!; });
      doc.y = y + 14;
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.8).strokeColor(INK).stroke();
      doc.y += 3;
    };
    ensure(40);
    drawHeader();
    for (const row of rows) {
      doc.font("r").fontSize(9.5);
      const cells = row.map((c) => (typeof c === "string" ? { text: c } : c));
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(c.text, { width: widths[i]! - 2 * pad }))) + 2 * pad;
      if (doc.y + h > bottom()) { doc.addPage(); drawHeader(); }
      const y = doc.y;
      let x = M;
      cells.forEach((c, i) => {
        doc.font(i === 0 ? "s" : "r").fontSize(9.5).fillColor(c.color ?? INK)
          .text(c.text, x + pad, y + pad, { width: widths[i]! - 2 * pad, align: cols[i]!.align ?? "left" });
        x += widths[i]!;
      });
      doc.y = y + h;
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.4).strokeColor(LINE).stroke();
    }
    doc.x = M;
    doc.y += 6;
  };

  /** Big-number tiles in one row. */
  const tiles = (items: { label: string; value: string; sub?: string }[]) => {
    ensure(64);
    const gap = 10, w = (W - gap * (items.length - 1)) / items.length, y = doc.y;
    items.forEach((t, i) => {
      const x = M + i * (w + gap);
      doc.roundedRect(x, y, w, 58, 4).lineWidth(0.6).strokeColor(LINE).stroke();
      doc.font("s").fontSize(7.5).fillColor(MUTED).text(t.label.toLocaleUpperCase("tr-TR"), x + 8, y + 8, { width: w - 16 });
      doc.font("b").fontSize(16).fillColor(INK).text(t.value, x + 8, y + 22, { width: w - 16 });
      if (t.sub) doc.font("r").fontSize(7.5).fillColor(MUTED).text(t.sub, x + 8, y + 43, { width: w - 16 });
    });
    doc.y = y + 58;
    doc.x = M;
  };

  // ------------------------------------------------------------------ cover block
  const e = data.event;
  doc.font("s").fontSize(8).fillColor(ACCENT).text("ETKİNLİK RAPORU", M, M);
  doc.moveDown(0.4);
  doc.font("b").fontSize(22).fillColor(INK).text(e.title, { width: W });
  doc.moveDown(0.3);
  doc.font("r").fontSize(10.5).fillColor(MUTED)
    .text([data.organization, e.city, formatDateRange(e.startDate, e.endDate), EVENT_STATUS_LABEL[e.status]].filter(Boolean).join(" · "), { width: W });
  doc.moveDown(0.6);
  doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(1.2).strokeColor(INK).stroke();
  doc.moveDown(0.6);
  note(`Rapor tarihi: ${formatDateTime(data.generatedAt)}. Bu rapordaki tüm sayılar sistemde kayıtlı verilerden alınmıştır; tahmin içermez. Ölçülemeyen değerler “—” veya “Veri yok” olarak gösterilir.`);

  // ------------------------------------------------------------------ attendance and tasks
  section("01 · Katılım ve operasyon", "Katılım");
  const a = data.attendance;
  tiles([
    { label: "Geçerli bilet", value: formatNumber(a.tickets), sub: a.cancelled ? `${formatNumber(a.cancelled)} iptal` : undefined },
    { label: "Girişte okutulan", value: formatNumber(a.checkedIn), sub: a.tickets ? `${formatPercent(a.checkedIn, a.tickets)} katılım` : undefined },
    { label: "Kayıt formundan", value: formatNumber(a.registrations), sub: "kişisel verisi saklanan kayıt" },
    { label: "Görevler", value: `${formatNumber(data.tasks.done)} / ${formatNumber(data.tasks.total)}`, sub: data.tasks.total ? `${formatPercent(data.tasks.done, data.tasks.total)} tamamlandı` : undefined },
  ]);

  // ------------------------------------------------------------------ KPIs
  section("02 · Hedefler", "KPI'lar");
  if (data.kpis.length) {
    table(
      [{ title: "Metrik", width: 0.4 }, { title: "Durum", width: 0.13 }, { title: "Hedef", width: 0.15, align: "right" }, { title: "Gerçekleşen", width: 0.16, align: "right" }, { title: "Kaynak", width: 0.16 }],
      data.kpis.map((k) => [k.name, k.status, k.target, k.actual, { text: k.source, color: k.source === "Veri yok" ? MUTED : INK }]),
    );
    note("Hesaplandı: değer platformun KPI motoru tarafından kayıtlı verilerden hesaplandı. Elle girildi: düzenleyicinin girdiği değer.");
  } else note("Bu etkinlik için KPI tanımlanmamış.");

  // ------------------------------------------------------------------ surveys
  section("03 · Ölçüm", "Anketler");
  if (data.surveys.length) {
    table(
      [{ title: "Kitle", width: 0.22 }, { title: "Anket", width: 0.42 }, { title: "Durum", width: 0.14 }, { title: "Yanıt", width: 0.22, align: "right" }],
      data.surveys.map((s) => [s.audience, `${s.title} (s. ${s.version})`, s.status, s.target ? `${formatNumber(s.responses)} / ${formatNumber(s.target)}` : formatNumber(s.responses)]),
    );
    note("Yanıt sayılarına hariç tutulan yanıtlar dahil değildir.");
  } else note("Bu etkinlik için anket yok.");

  // ------------------------------------------------------------------ budget
  if (data.budget) {
    section("04 · Finans", "Bütçe");
    const b = data.budget;
    table(
      [{ title: "Kalem", width: 0.4 }, { title: "Planlanan", width: 0.3, align: "right" }, { title: "Gerçekleşen", width: 0.3, align: "right" }],
      [["Gelir", formatTry(b.income.planned), formatTry(b.income.actual)], ["Gider", formatTry(b.cost.planned), formatTry(b.cost.actual)], ["Net", formatTry(b.net.planned), formatTry(b.net.actual)]],
    );
  }

  // ------------------------------------------------------------------ impact
  section(data.budget ? "05 · Etki" : "04 · Etki", "Ekonomik etki");
  if (data.impact) {
    const im = data.impact;
    note(`Kaynak: hesaplama kaydı ${im.id} · ${formatDateTime(im.createdAt)} · motor ${im.engineVersion}.`);
    table(
      [{ title: "Bilgi", width: 0.45 }, { title: "Değer", width: 0.55 }],
      [
        ["İstenen seviye", im.requestedLevel],
        ["Ulaşılan seviye", im.achievedLevel ?? "Veri yetersiz — rakam üretilmedi"],
        ...(im.attendance ? [["Kullanılan katılım", im.attendance]] : []),
        ...(im.sampleSize !== null ? [["Örneklem (yanıt)", formatNumber(im.sampleSize)]] : []),
        ...im.figures.map((x) => [x.label, x.value]),
      ],
    );
    if (im.checks.length) {
      doc.moveDown(0.8);
      doc.font("s").fontSize(10).fillColor(INK).text("Veri yeterliliği kontrolleri", M);
      doc.moveDown(0.3);
      table(
        [{ title: "Kontrol", width: 0.75 }, { title: "Sonuç", width: 0.25 }],
        im.checks.map((c) => [c.label, { text: c.passed ? "Sağlandı" : "Sağlanmadı", color: c.passed ? PASS : FAIL }]),
      );
    }
  } else note("Kayıtlı etki hesaplaması yok. Etki sekmesinden hesaplama çalıştırıldığında rakamlar bu bölümde yer alır.");

  // ------------------------------------------------------------------ management summary (draft)
  const text = summary?.trim();
  if (text) {
    doc.addPage();
    doc.font("s").fontSize(8).fillColor(ACCENT).text("EK · YÖNETİM ÖZETİ (TASLAK)", M, M);
    doc.moveDown(0.3);
    note("Bu bölüm yapay zekâ asistanı tarafından kayıtlı verilerden hazırlanmış bir taslaktır; yetkili onayından önce paylaşmayın.");
    doc.moveDown(0.4);
    for (const blk of summaryBlocks(text)) {
      ensure(30);
      if (blk.kind === "heading") { doc.moveDown(0.4); doc.font("b").fontSize(12).fillColor(INK).text(blk.text, M, doc.y, { width: W }); doc.moveDown(0.2); }
      else if (blk.kind === "bullets") { doc.font("r").fontSize(10).fillColor(INK).list(blk.items, M + 6, doc.y, { width: W - 6, bulletRadius: 1.6, textIndent: 10, paragraphGap: 2 }); doc.moveDown(0.4); }
      else { doc.font("r").fontSize(10).fillColor(INK).text(blk.text, M, doc.y, { width: W, lineGap: 2 }); doc.moveDown(0.6); }
    }
  }

  // ------------------------------------------------------------------ footer on every page
  const range = doc.bufferedPageRange();
  const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date(data.generatedAt));
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - M + 4;
    doc.page.margins.bottom = 0; // writing inside the bottom margin must not add a page
    doc.font("r").fontSize(7.5).fillColor(MUTED);
    doc.text(`${data.event.title} · ${formatDate(localDay)}`, M, y, { width: W * 0.7, lineBreak: false, height: 10 });
    doc.text(`Sayfa ${i - range.start + 1} / ${range.count}`, M + W * 0.7, y, { width: W * 0.3, align: "right", lineBreak: false, height: 10 });
  }
  doc.end();
  return done;
}

/** "Adana Lezzet Festivali" → "adana-lezzet-festivali" (download file name). */
export const reportFileName = (title: string, iso: string) =>
  `etkinlik-raporu-${title.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "etkinlik"}-${iso.slice(0, 10)}.pdf`;
