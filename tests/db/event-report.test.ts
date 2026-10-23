/**
 * The downloadable event report (PDF): built from stored records only, budget only for budget.read, the assistant's
 * draft as a labelled annex, another organization gets a 404. Text checked with pdftotext.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { attendees, budgetItems, eventKpis, events, tasks } from "@/db/schema";
import { ORG_A, ORG_B, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown, user: null as string | null }));
vi.mock("@/db", async () => {
  const { withRls } = await import("@/db/rls");
  class UnauthenticatedError extends Error {}
  const claims = () => { if (!h.user) throw new UnauthenticatedError("Not signed in"); return { sub: h.user }; };
  return {
    UnauthenticatedError,
    getVerifiedClaims: async () => claims(),
    getUserDb: async () => { const c = claims(); return <T,>(fn: Parameters<typeof withRls<T>>[2]) => withRls(h.db as never, c, fn); },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});

const route = await import("@/app/api/events/[eventId]/report/route");
let ev = "";
const dir = mkdtempSync(path.join(tmpdir(), "eip-report-"));
const report = async (user: string, body: Record<string, unknown> = {}) => {
  h.user = user;
  return route.POST(new Request("http://localhost:3000/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: ORG_A, ...body }) }),
    { params: Promise.resolve({ eventId: ev }) });
};
const text = async (r: Response) => {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
};

beforeAll(async () => {
  const ctx = await setupDb();
  h.db = ctx.db;
  ev = (await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Şırnak Güz Şenliği", status: "live", startDate: "2026-11-20", endDate: "2026-11-22",
    aiConfig: { event: { city: "Şırnak" } }, aiConfigVersion: "blueprint/v1" }).returning({ id: events.id }))[0]!.id;
  await ctx.db.insert(attendees).values([1, 2, 3, 4].map((i) => ({ organizationId: ORG_A, eventId: ev, ticketType: "Genel", isCheckedIn: i <= 3, checkedInAt: i <= 3 ? new Date() : null })));
  await ctx.db.insert(tasks).values([{ organizationId: ORG_A, eventId: ev, title: "Mekân", status: "DONE" }, { organizationId: ORG_A, eventId: ev, title: "Ses", status: "TODO" }] as never);
  await ctx.db.insert(eventKpis).values({ organizationId: ORG_A, eventId: ev, metricName: "overall_satisfaction", dataSource: "survey", status: "ACTIVE", targetValue: "4.2" } as never);
  await ctx.db.insert(budgetItems).values([
    { organizationId: ORG_A, eventId: ev, kind: "INCOME", category: "SPONSORSHIP", label: "Sponsor", plannedKurus: 50_000_000, actualKurus: 42_000_000 },
    { organizationId: ORG_A, eventId: ev, kind: "COST", category: "VENUE", label: "Mekân", plannedKurus: 30_000_000 },
  ] as never);
}, 60_000);

describe("event report PDF", () => {
  it("owner: a PDF with attendance, tasks, KPIs, budget and the impact placeholder; Turkish text intact", async () => {
    const r = await report(U.ownerA);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="etkinlik-raporu-sirnak-guz-senligi-\d{4}-\d{2}-\d{2}\.pdf"/);
    const t = await text(r);
    expect(t).toContain("Şırnak Güz Şenliği");
    expect(t).toMatch(/Org A · Şırnak · 20–22 Kas 2026|Org A · Şırnak/);
    expect(t).toMatch(/GEÇERLİ BİLET[\s\S]*4/);
    expect(t).toContain("%75,0 katılım");
    expect(t).toMatch(/GÖREVLER[\s\S]*1\s*\/\s*2/);
    expect(t).toMatch(/Bütçe/);
    expect(t).toContain("₺ 500.000");
    expect(t).toContain("₺ 420.000");
    expect(t).toContain("Kayıtlı etki hesaplaması yok");
    expect(t).toMatch(/Veri yok/);
    expect(t).toMatch(/Sayfa 1 \/ \d/);
    expect(t).not.toContain("YÖNETİM ÖZETİ");
  });

  it("staff: no budget section; the assistant draft becomes a labelled annex", async () => {
    const t = await text(await report(U.staffA, { summary: "## Genel değerlendirme\n\nKatılım **beklentinin** üzerinde.\n\n- Giriş akışı sorunsuz\n- Anket yanıtları az" }));
    expect(t).not.toMatch(/Bütçe/);
    expect(t).not.toContain("500.000");
    expect(t).toContain("YÖNETİM ÖZETİ (TASLAK)");
    expect(t).toContain("Genel değerlendirme");
    expect(t).toContain("Katılım beklentinin üzerinde.");
    expect(t).not.toContain("**");
    expect(t).toContain("Giriş akışı sorunsuz");
  });

  it("another organization's member gets 404; invalid body 400", async () => {
    h.user = U.ownerB;
    const r = await route.POST(new Request("http://localhost:3000/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: ORG_B }) }),
      { params: Promise.resolve({ eventId: ev }) });
    expect(r.status).toBe(404);
    expect((await report(U.ownerA, { summary: "x".repeat(40_001) })).status).toBe(400);
  });
});
