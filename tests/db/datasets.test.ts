/**
 * Own data tables (migration 0014) through their Route Handlers on a migrated database, with the language model
 * replaced by a mock: upload (.xlsx and .csv; personal columns never stored; .xls refused), the model's mapping
 * suggestion (only column statistics are sent; invalid suggestions are dropped), confirmation, metrics fed by
 * confirmed tables only, the interpretation (grounded on computed numbers) and permissions / tenant isolation.
 */
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiGenerations, attendees, eventDatasets, events } from "@/db/schema";
import type { MockState } from "./ai-mocks";
import { ORG_A, ORG_B, outcome, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown, user: null as string | null, ai: { respond: () => "{}", calls: [] } as unknown as MockState }));
vi.mock("@/db", async () => {
  const { withRls } = await import("@/db/rls");
  class UnauthenticatedError extends Error {}
  const claims = () => {
    if (!h.user) throw new UnauthenticatedError("Not signed in");
    return { sub: h.user };
  };
  return {
    UnauthenticatedError,
    getVerifiedClaims: async () => claims(),
    getUserDb: async () => {
      const c = claims();
      return <T,>(fn: Parameters<typeof withRls<T>>[2]) => withRls(h.db as never, c, fn);
    },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});
vi.mock("@/server/ai/models", async (orig) => {
  const real = await orig<typeof import("@/server/ai/models")>();
  const { mockModel } = await import("./ai-mocks");
  return { ...real, modelFor: () => mockModel(h.ai), assertAiConfigured: () => {} };
});

const listRoute = await import("@/app/api/events/[eventId]/datasets/route");
const oneRoute = await import("@/app/api/datasets/[datasetId]/route");
const interpretRoute = await import("@/app/api/datasets/[datasetId]/interpret/route");
const metricsRoute = await import("@/app/api/events/[eventId]/metrics/route");
const { datasetsContext } = await import("@/server/datasets/dataset-service");

let ctx: Awaited<ReturnType<typeof setupDb>>;
let ev = "";
const as = (user: string | null) => { h.user = user; };
const send = (method: string, body?: unknown) =>
  new Request("http://test.local/api", { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (q: Record<string, string>) => new Request(`http://test.local/api?${new URLSearchParams(q)}`);
const P = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: r.status === 204 ? null : await r.json() });
const b64 = (f: string) => readFileSync(`src/server/datasets/__tests__/fixtures/${f}`).toString("base64");
const upload = (body: Record<string, unknown>, user = U.ownerA) => {
  as(user);
  return listRoute.POST(send("POST", { organizationId: ORG_A, ...body }), P({ eventId: ev })).then(json);
};
const list = async () => { as(U.staffA); return (await json(await listRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body; };
const metric = async (id: string) => {
  as(U.staffA);
  const r = await json(await metricsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })));
  return r.body.values.find((v: { id: string }) => v.id === id);
};
const confirm = (id: string, mapping: { key: string; role: string }[], user = U.ownerA) => {
  as(user);
  return oneRoute.PATCH(send("PATCH", { organizationId: ORG_A, mapping }), P({ datasetId: id })).then(json);
};

/** Mapping suggestions: the model sees the system prompt; the answer is keyed by what the prompt asks for. */
let suggestion: unknown = { title: "Saha raporu", columns: [] };
let interpretation = "- Toplam atık 1999,5 kg.\nÖneri: geri dönüşüm istasyonlarını artırın.";

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  h.ai.respond = (system: string) => (/sütunlarının ne anlama/.test(system) ? JSON.stringify(suggestion) : interpretation);
  ev = (await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Kordon Festivali", startDate: "2026-10-23", endDate: "2026-10-25" })
    .returning({ id: events.id }))[0]!.id;
  // 1000 check-ins
  await ctx.db.insert(attendees).values(Array.from({ length: 1000 }, () => ({ organizationId: ORG_A, eventId: ev, ticketType: "general", isCheckedIn: true, checkedInAt: new Date() })));
});

describe("own data tables", () => {
  let field = "";

  it("an .xlsx upload is read, personal columns are dropped before storing, and only statistics reach the model", async () => {
    h.ai.calls.length = 0;
    expect((await upload({ fileName: "saha.xlsx", content: b64("openpyxl.xlsx") }, U.staffA)).status).toBe(403);
    const r = await upload({ fileName: "saha.xlsx", content: b64("openpyxl.xlsx") });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ sheets: ["Atık ve Olaylar", "Oturumlar"], sheet: "Atık ve Olaylar", rows: 5, columns: 6 });
    expect(r.body.droppedColumns.map((d: { header: string }) => d.header)).toEqual(["Sorumlu Ad Soyad", "E-posta"]);
    field = r.body.id;
    const [row] = await ctx.db.select().from(eventDatasets).where(eq(eventDatasets.id, field));
    expect(JSON.stringify(row)).not.toMatch(/Ayşe|@ornek/);
    expect(row).toMatchObject({ status: "NEEDS_REVIEW", name: "Saha raporu", rowCount: 5, headerRow: 3 });
    // the model got headers and statistics, never row values
    const prompt = JSON.stringify(h.ai.calls.at(-1));
    expect(prompt).toContain("toplam_atik_kg");
    expect(prompt).not.toMatch(/Ayşe|ornek\.com|Sahil.*Sahil.*Sahil.*Sahil/);
    const [gen] = await ctx.db.select().from(aiGenerations).where(and(eq(aiGenerations.organizationId, ORG_A), eq(aiGenerations.kind, "dataset_mapping")));
    expect(gen).toMatchObject({ status: "SUCCEEDED" });
  });

  it("an unconfirmed table does not feed metrics; confirming does", async () => {
    expect(await metric("waste_per_attendee_kg")).toMatchObject({ value: null });
    as(U.staffA);
    expect((await json(await oneRoute.GET(get({ organizationId: ORG_A }), P({ datasetId: field })))).status).toBe(403);
    as(U.ownerA);
    const preview = (await json(await oneRoute.GET(get({ organizationId: ORG_A }), P({ datasetId: field })))).body;
    expect(preview.rows).toHaveLength(5);
    const mapping = preview.mapping.map((m: { key: string; role: string }) => ({ key: m.key, role: m.role }));
    expect(mapping.map((m: { role: string }) => m.role)).toEqual(["date", "group", "measure:waste_kg", "measure:recycled_kg", "measure:incidents", "measure:vendor_on_time"]);
    // a measure on a text column is refused with the reason
    const bad = await confirm(field, mapping.map((m: { key: string; role: string }) => (m.key === "alan" ? { ...m, role: "measure:waste_kg" } : m)));
    expect(bad).toMatchObject({ status: 422, body: { code: "DATASET_MAPPING" } });
    expect(await confirm(field, mapping, U.staffA)).toMatchObject({ status: 403 });
    expect(await confirm(field, mapping)).toMatchObject({ status: 200, body: { status: "CONFIRMED" } });
    expect((await metric("waste_per_attendee_kg")).value).toBeCloseTo(1.9995, 10);
    expect((await metric("recycling_rate")).value).toBeCloseTo((585.5 / 1999.5) * 100, 10);
    expect(await metric("incident_rate_per_1000")).toMatchObject({ value: 7 });
    expect(await metric("vendor_on_time_rate")).toMatchObject({ value: 80 });
    const l = await list();
    expect(l.datasets[0]).toMatchObject({ status: "CONFIRMED", summary: { rows: 5 } });
    expect(l.datasets[0].rows).toBeUndefined();
  });

  it("a CSV upload: the model's valid suggestions are kept, invalid ones dropped, a rule match is not overridden", async () => {
    suggestion = {
      title: "Kapı sayımı",
      columns: [
        { key: "kapi_a_gecis", role: "measure:visitors", reason: "Kapıdan geçen kişi sayısı" },
        { key: "gun", role: "measure:waste_kg", reason: "yanlış" }, // a date column cannot hold a number measure
        { key: "sikayet", role: "value", reason: "rule already says complaints" },
      ],
    };
    const csv = "Gün;Kapı A geçiş;Şikâyet;Telefon\n23.10.2026;4.000;6;0532 111 22 33\n24.10.2026;6.000;4;0533 444 55 66\n";
    const r = await upload({ fileName: "kapi.csv", content: Buffer.from(csv).toString("base64") });
    expect(r.status).toBe(201);
    expect(r.body.droppedColumns.map((d: { header: string }) => d.header)).toEqual(["Telefon"]);
    as(U.ownerA);
    const preview = (await json(await oneRoute.GET(get({ organizationId: ORG_A }), P({ datasetId: r.body.id })))).body;
    expect(preview.mapping.map((m: { key: string; role: string; source: string }) => [m.key, m.role, m.source])).toEqual([
      ["gun", "date", "rule"], ["kapi_a_gecis", "measure:visitors", "ai"], ["sikayet", "measure:complaints", "rule"],
    ]);
    expect(preview.name).toBe("Kapı sayımı");
  });

  it("refuses .xls and unknown files with clear codes", async () => {
    expect(await upload({ fileName: "eski.xls", content: b64("legacy.xls") })).toMatchObject({ status: 422, body: { code: "DATASET_XLS" } });
    expect(await upload({ fileName: "eski.xlsx", content: b64("legacy.xls") })).toMatchObject({ status: 422, body: { code: "DATASET_UNREADABLE" } });
    expect(await upload({ fileName: "foto.png", content: "aGVsbG8=" })).toMatchObject({ status: 422, body: { code: "DATASET_TYPE" } });
    expect(await upload({ fileName: "a.xlsx", content: b64("openpyxl.xlsx"), sheet: "Yok" })).toMatchObject({ status: 422, body: { code: "DATASET_SHEET" } });
  });

  it("interpretation needs a confirmed table, is written from computed numbers and becomes stale when the mapping changes", async () => {
    const unconfirmed = (await list()).datasets.find((d: { status: string }) => d.status === "NEEDS_REVIEW").id;
    as(U.ownerA);
    expect(await json(await interpretRoute.POST(send("POST", { organizationId: ORG_A }), P({ datasetId: unconfirmed })))).toMatchObject({ status: 409 });
    h.ai.calls.length = 0;
    as(U.staffA);
    expect((await interpretRoute.POST(send("POST", { organizationId: ORG_A }), P({ datasetId: field }))).status).toBe(403);
    as(U.ownerA);
    const r = await json(await interpretRoute.POST(send("POST", { organizationId: ORG_A }), P({ datasetId: field })));
    expect(r).toMatchObject({ status: 200, body: { text: interpretation } });
    const sent = h.ai.calls.at(-1)!;
    expect(sent.system).toMatch(/yalnızca verilen rakamları kullan/);
    expect(JSON.stringify(sent)).toContain("1999.5");
    expect(JSON.stringify(sent)).toContain("katilim_checkin");
    let d = (await list()).datasets.find((x: { id: string }) => x.id === field);
    expect(d.interpretation).toMatchObject({ text: interpretation, stale: false });
    // the assistant / report context carries the table and its interpretation
    expect((await datasetsContext(ORG_A, ev)).join("\n")).toMatch(/Saha raporu[\s\S]*Toplam atık \(kg\): toplam 1\.999,5[\s\S]*Yorum/);
    await confirm(field, [{ key: "olay_sayisi", role: "ignore" }, { key: "tarih", role: "date" }, { key: "alan", role: "group" },
      { key: "toplam_atik_kg", role: "measure:waste_kg" }, { key: "geri_donusum_kg", role: "measure:recycled_kg" }, { key: "zamaninda_teslim", role: "measure:vendor_on_time" }]);
    d = (await list()).datasets.find((x: { id: string }) => x.id === field);
    expect(d.interpretation.stale).toBe(true);
    expect(await metric("incident_rate_per_1000")).toMatchObject({ value: null });
    // provider failures map to clear codes
    as(U.ownerA);
    h.ai.respond = () => new Error("429 RESOURCE_EXHAUSTED");
    expect(await json(await interpretRoute.POST(send("POST", { organizationId: ORG_A }), P({ datasetId: field })))).toMatchObject({ status: 429, body: { code: "AI_QUOTA" } });
    h.ai.respond = () => new Error("upstream exploded");
    expect(await json(await interpretRoute.POST(send("POST", { organizationId: ORG_A }), P({ datasetId: field })))).toMatchObject({ status: 502, body: { code: "AI_PROVIDER_ERROR" } });
  });

  it("other tenants see nothing; the table is server-only for browsers; deleting removes its metrics", async () => {
    as(U.ownerB);
    expect((await listRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
    expect((await oneRoute.DELETE(get({ organizationId: ORG_B }), P({ datasetId: field }))).status).toBe(404);
    // like the other server-written tables, browsers get no direct privileges; members read through the API
    expect(await outcome(ctx.as(U.staffA, (tx) => tx.select({ id: eventDatasets.id }).from(eventDatasets)))).toMatch(/permission denied/);
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.delete(eventDatasets)))).toMatch(/permission denied/);
    as(U.ownerA);
    expect((await oneRoute.DELETE(get({ organizationId: ORG_A }), P({ datasetId: field }))).status).toBe(204);
    expect(await metric("waste_per_attendee_kg")).toMatchObject({ value: null });
  });
});
