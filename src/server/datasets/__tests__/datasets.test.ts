/**
 * Own-data uploads: the .xlsx reader on workbooks written by two different producers (openpyxl, LibreOffice), the
 * table builder (header row, types, personal-data columns, total rows), the column mapping, and the metrics and
 * summaries computed from a confirmed table.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { proposeMapping, validateMapping, type ColumnMapping } from "@/lib/datasets/measures";
import { buildTable, parseDate, parseNumber } from "@/lib/datasets/table";
import { computeDatasetKpis, summarizeDataset } from "@/lib/kpi/datasets";
import { readXlsx, WorkbookError } from "../xlsx";

const fixture = (f: string) => readFileSync(`src/server/datasets/__tests__/fixtures/${f}`);

describe("xlsx reader", () => {
  for (const f of ["openpyxl.xlsx", "libreoffice.xlsx"]) {
    it(`reads visible sheets, shared strings, dates and booleans (${f})`, () => {
      const sheets = readXlsx(fixture(f));
      expect(sheets.map((s) => s.name)).toEqual(["Atık ve Olaylar", "Oturumlar"]); // the hidden sheet is skipped
      const rows = sheets[0]!.rows;
      expect(rows[0]).toEqual(["Kordon Festivali — saha raporu"]);
      expect(rows[3]).toEqual(["2026-10-23", "Sahil", 420.5, 160, 2, "Ayşe Yılmaz", "ayse@ornek.com", "evet"]);
      expect(sheets[1]!.rows[1]).toEqual(["Açılış", 200, 180, 250, 4.6, true]);
      // the SUM under the table is not read as data
      expect(rows.slice(8).flat().filter((c) => c !== null)).toEqual([]);
    });
  }

  it("refuses .xls and non-workbook files with a clear message", () => {
    expect(() => readXlsx(fixture("legacy.xls"))).toThrow(/Excel 97–2003/);
    expect(() => readXlsx(Buffer.from("tarih;atik\n2026-01-01;5\n"))).toThrow(WorkbookError);
  });
});

describe("table builder", () => {
  it("finds the header under a title, types columns and drops personal data", () => {
    const t = buildTable(readXlsx(fixture("openpyxl.xlsx"))[0]!.rows);
    expect(t.headerRow).toBe(3);
    expect(t.columns.map((c) => [c.header, c.type])).toEqual([
      ["Tarih", "date"], ["Alan", "text"], ["Toplam atık (kg)", "number"], ["Geri dönüşüm (kg)", "number"], ["Olay sayısı", "number"], ["Zamanında teslim", "boolean"],
    ]);
    expect(t.droppedColumns.map((d) => d.header)).toEqual(["Sorumlu Ad Soyad", "E-posta"]);
    expect(JSON.stringify(t.rows)).not.toMatch(/Ayşe|@ornek/);
    expect(t.rows).toHaveLength(5);
    expect(t.columns.find((c) => c.key === "toplam_atik_kg")!.stats).toMatchObject({ sum: 1999.5, min: 288, max: 515 });
  });

  it("reads CSV-style text: Turkish numbers and dates, evet/hayır, phone columns by content, total rows", () => {
    expect([parseNumber("1.234,5"), parseNumber("1,234,567"), parseNumber("12,5"), parseNumber("₺ 2.500"), parseNumber("abc"), parseNumber("3.5")]).toEqual([1234.5, 1234567, 12.5, 2500, null, 3.5]);
    expect([parseDate("23.10.2026"), parseDate("2026-10-23 14:30"), parseDate("31/13/2026")]).toEqual(["2026-10-23", "2026-10-23T14:30", null]);
    const t = buildTable([
      ["Gün", "Stant", "İletişim", "Satış (TL)", "Normal gün satış (TL)"],
      ["23.10.2026", "A", "0532 111 22 33", "1.250,50", "900"],
      ["24.10.2026", "B", "0533 444 55 66", "2.000", "1.100"],
      ["Toplam", null, null, "3.250,50", "2.000"],
    ]);
    expect(t.columns.map((c) => c.header)).toEqual(["Gün", "Stant", "Satış (TL)", "Normal gün satış (TL)"]);
    expect(t.droppedColumns).toEqual([{ header: "İletişim", reason: "e-posta veya telefon içeriyor" }]);
    expect(t.totalRowsRemoved).toBe(1);
    expect(t.rows).toEqual([["2026-10-23", "A", 1250.5, 900], ["2026-10-24", "B", 2000, 1100]]);
  });

  it("explains a sheet without a header", () => {
    expect(() => buildTable([[1, 2], [3, 4]])).toThrow(/Başlık satırı/);
  });
});

describe("mapping", () => {
  it("proposes roles from headers (with session context) and validates confirmed ones", () => {
    const sessions = buildTable(readXlsx(fixture("openpyxl.xlsx"))[1]!.rows);
    const m = proposeMapping(sessions.columns, sessions.rows.length);
    expect(m.map((x) => x.role)).toEqual(["group", "measure:session_registered", "measure:session_checkins", "measure:session_capacity",
      "measure:session_rating", "measure:session_on_time"]);
    expect(validateMapping(sessions.columns, m)).toEqual([]);
    const bad: ColumnMapping[] = [{ key: "oturum", role: "measure:waste_kg", source: "user" }, { key: "kayitli", role: "date", source: "user" },
      { key: "katilan", role: "measure:session_capacity", source: "user" }, { key: "kapasite", role: "measure:session_capacity", source: "user" }];
    expect(validateMapping(sessions.columns, bad)).toEqual([
      'Oturum: "Toplam atık (kg)" sayı ister', "Kayıtlı: tarih değil", '"Oturum kapasitesi" birden fazla sütuna atanmış',
    ]);
  });
});

describe("metrics and summaries from confirmed tables", () => {
  const wb = readXlsx(fixture("openpyxl.xlsx"));
  const make = (i: number, id: string, name: string) => {
    const t = buildTable(wb[i]!.rows);
    return { id, name, columns: t.columns, rows: t.rows, mapping: proposeMapping(t.columns, t.rows.length) };
  };
  const field = make(0, "d1", "Saha raporu"), sessions = make(1, "d2", "Oturumlar");
  const get = (vals: ReturnType<typeof computeDatasetKpis>, id: string) => vals.find((v) => v.id === id)!;

  it("follows the catalog formulas; gelen = check-ins", () => {
    const v = computeDatasetKpis([field, sessions], { checkedIn: 1000, validTickets: 1200 });
    expect(get(v, "waste_per_attendee_kg").value).toBeCloseTo(1999.5 / 1000, 10);
    expect(get(v, "recycling_rate").value).toBeCloseTo((585.5 / 1999.5) * 100, 10); // the empty recycling cell is not 0 … but the sum skips it
    expect(get(v, "incident_rate_per_1000").value).toBe(7);
    expect(get(v, "vendor_on_time_rate").value).toBe(80);
    expect(get(v, "session_attendance_rate").value).toBeCloseTo((355 / 380) * 100, 10);
    expect(get(v, "session_fill_rate").value).toBeCloseTo((355 / 430) * 100, 10);
    expect(get(v, "avg_sessions_per_attendee").value).toBeCloseTo(0.355, 10);
    expect(get(v, "session_satisfaction").value).toBeCloseTo((4.6 + 4.2 + 3.9) / 3, 10);
    expect(get(v, "schedule_adherence_rate").value).toBeCloseTo(200 / 3, 10);
    expect(get(v, "incident_rate_per_1000").note).toMatch(/Saha raporu/);
    expect(get(v, "carbon_footprint_kgco2e").value).toBeNull();
  });

  it("without check-ins, uploaded visitor counts are the base, and that is stated", () => {
    const t = buildTable([["Tarih", "Ziyaretçi", "Şikâyet"], ["2026-10-23", 4000, 6], ["2026-10-24", 6000, 4]]);
    const d = { id: "d3", name: "Kapı sayımı", columns: t.columns, rows: t.rows, mapping: proposeMapping(t.columns, t.rows.length) };
    expect(d.mapping.map((m) => m.role)).toEqual(["date", "measure:visitors", "measure:complaints"]);
    const v = computeDatasetKpis([d], { checkedIn: 0, validTickets: 0 });
    expect(get(v, "complaint_rate_per_1000")).toMatchObject({ value: 1, note: expect.stringMatching(/ziyaretçi sayımı/) });
  });

  it("emission: activity × factor row by row, plus already computed CO₂e", () => {
    const t = buildTable([["Kaynak", "Faaliyet miktarı", "Emisyon faktörü", "CO2e (kg)"], ["Jeneratör", 100, 2.5, null], ["Servis", 50, 0.2, null], ["Uçuş", null, null, 300]]);
    const d = { id: "d4", name: "Karbon", columns: t.columns, rows: t.rows, mapping: proposeMapping(t.columns, t.rows.length) };
    const v = computeDatasetKpis([d], { checkedIn: 100, validTickets: 100 });
    expect(get(v, "carbon_footprint_kgco2e").value).toBe(250 + 10 + 300);
    expect(get(v, "carbon_per_attendee_kgco2e").value).toBe(5.6);
  });

  it("summaries: totals, a date series and a group breakdown", () => {
    const s = summarizeDataset(field);
    expect(s.numbers.map((n) => [n.label, n.sum])).toEqual([["Toplam atık (kg)", 1999.5], ["Geri dönüşüme giden atık (kg)", 585.5], ["Olay sayısı", 7]]);
    expect(s.series.map((x) => [x.date, x.values.toplam_atik_kg])).toEqual([["2026-10-23", 730.5], ["2026-10-24", 803], ["2026-10-25", 466]]);
    expect(s.breakdown).toMatchObject({ group: "Alan", items: [{ label: "Sahil", value: 1401.5, rows: 3 }, { label: "Meydan", value: 598, rows: 2 }] });
    expect(s.booleans[0]).toMatchObject({ trueShare: 80, n: 5 });
  });
});
