/**
 * Event budget (budget_items, migration 0012) through its Route Handlers on a migrated database: owner/admin only
 * (staff sees neither lines nor finance metrics), validation equal to the table's CHECKs, tenant scope, CSV export,
 * and the finance metrics computed from the lines.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { events } from "@/db/schema";
import { ORG_A, ORG_B, outcome, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown, user: null as string | null }));
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

const budgetRoute = await import("@/app/api/events/[eventId]/budget/route");
const exportRoute = await import("@/app/api/events/[eventId]/budget/export/route");
const itemRoute = await import("@/app/api/budget-items/[itemId]/route");
const metricsRoute = await import("@/app/api/events/[eventId]/metrics/route");

let ctx: Awaited<ReturnType<typeof setupDb>>;
let ev = "", evB = "";
const as = (user: string | null) => { h.user = user; };
const send = (method: string, body?: unknown) =>
  new Request("http://test.local/api", { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (q: Record<string, string>) => new Request(`http://test.local/api?${new URLSearchParams(q)}`);
const P = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: r.status === 204 ? null : await r.json() });
const metric = async (user: string, id: string) => {
  as(user);
  const r = await json(await metricsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })));
  return r.body.values.find((v: { id: string }) => v.id === id);
};

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  ev = (await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Bütçeli etkinlik" }).returning({ id: events.id }))[0]!.id;
  evB = (await ctx.db.insert(events).values({ organizationId: ORG_B, title: "B etkinliği" }).returning({ id: events.id }))[0]!.id;
});

describe("budget lines", () => {
  let venueId = "";
  const venue = { organizationId: ORG_A, kind: "COST", category: "VENUE", label: "Salon kirası", planned: 18_000, actual: 20_000.5,
    costBehavior: "FIXED", supplierLocal: true, fundedExternally: true };

  it("owner/admin add lines; staff and other tenants cannot read or write them", async () => {
    as(U.staffA);
    expect((await budgetRoute.POST(send("POST", venue), P({ eventId: ev }))).status).toBe(403);
    expect((await budgetRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
    as(U.ownerB);
    expect((await budgetRoute.POST(send("POST", venue), P({ eventId: ev }))).status).toBe(403);
    expect((await budgetRoute.POST(send("POST", { ...venue, organizationId: ORG_B }), P({ eventId: ev }))).status).toBe(404); // ev is not B's
    as(U.ownerA);
    const r = await json(await budgetRoute.POST(send("POST", venue), P({ eventId: ev })));
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ kind: "COST", category: "VENUE", planned: 18_000, actual: 20_000.5, costBehavior: "FIXED" });
    venueId = r.body.item.id;
    expect((await budgetRoute.POST(send("POST", { organizationId: ORG_A, kind: "INCOME", category: "TICKETS", label: "Bilet", actual: 30_000, quantity: 100 }),
      P({ eventId: ev }))).status).toBe(201);
    expect((await budgetRoute.POST(send("POST", { organizationId: ORG_A, kind: "COST", category: "CATERING", label: "İkram", actual: 8_000,
      costBehavior: "VARIABLE", supplierLocal: true, fundedExternally: false }), P({ eventId: ev }))).status).toBe(201);
    const list = (await json(await budgetRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body;
    expect(list.items).toHaveLength(3);
    expect(list.totals).toMatchObject({ income: { actual: 30_000, planned: null }, cost: { actual: 28_000.5, planned: 18_000 }, net: { actual: 1_999.5 } });
    // the browser role has no privilege at all on the table (server-only)
    expect(await outcome(ctx.as(U.ownerA, (tx) => tx.execute("select * from budget_items" as never)))).toMatch(/permission denied/);
  });

  it("validation mirrors the table: category of kind, an amount, quantity only on ticket income, cost fields only on costs", async () => {
    as(U.ownerA);
    const post = (b: Record<string, unknown>) => budgetRoute.POST(send("POST", { organizationId: ORG_A, label: "x", actual: 1, ...b }), P({ eventId: ev }));
    expect((await post({ kind: "INCOME", category: "VENUE" })).status).toBe(400);
    expect((await post({ kind: "COST", category: "VENUE", actual: null })).status).toBe(400);
    expect((await post({ kind: "COST", category: "VENUE", quantity: 3 })).status).toBe(400);
    expect((await post({ kind: "INCOME", category: "SPONSORSHIP", costBehavior: "FIXED" })).status).toBe(400);
    expect((await post({ kind: "COST", category: "VENUE", actual: 1.234 })).status).toBe(400);
    expect((await post({ kind: "COST", category: "VENUE", actual: -5 })).status).toBe(400);
    expect((await post({ kind: "COST", category: "VENUE", label: "  " })).status).toBe(400);
    // and the database refuses the same even for server code
    expect(await outcome(ctx.pg.query(`insert into budget_items (organization_id, event_id, kind, category, label, actual_kurus, quantity)
      values ($1, $2, 'COST', 'VENUE', 'x', 1, 5)`, [ORG_A, ev]))).toMatch(/budget_items_quantity/);
  });

  it("edit and delete: owner only within the organization; a kind change drops fields that no longer apply", async () => {
    as(U.staffA);
    expect((await itemRoute.PATCH(send("PATCH", { organizationId: ORG_A, actual: 1 }), P({ itemId: venueId }))).status).toBe(403);
    as(U.ownerB);
    expect((await itemRoute.PATCH(send("PATCH", { organizationId: ORG_B, actual: 1 }), P({ itemId: venueId }))).status).toBe(404);
    as(U.ownerA);
    const r = await json(await itemRoute.PATCH(send("PATCH", { organizationId: ORG_A, actual: 21_000 }), P({ itemId: venueId })));
    expect(r.body.item).toMatchObject({ actual: 21_000, planned: 18_000, supplierLocal: true });
    expect((await itemRoute.PATCH(send("PATCH", { organizationId: ORG_A, kind: "INCOME" }), P({ itemId: venueId }))).status).toBe(400); // VENUE is not income
    const moved = await json(await itemRoute.PATCH(send("PATCH", { organizationId: ORG_A, kind: "INCOME", category: "GRANT" }), P({ itemId: venueId })));
    expect(moved.body.item).toMatchObject({ kind: "INCOME", category: "GRANT", costBehavior: null, supplierLocal: null, fundedExternally: null });
    await itemRoute.PATCH(send("PATCH", { organizationId: ORG_A, kind: "COST", category: "VENUE", costBehavior: "FIXED", supplierLocal: true, fundedExternally: true }),
      P({ itemId: venueId }));
    as(U.ownerB);
    expect((await itemRoute.DELETE(get({ organizationId: ORG_B }), P({ itemId: venueId }))).status).toBe(404);
  });

  it("finance metrics come from the lines and are hidden from staff", async () => {
    // income 30,000 (100 tickets); costs 21,000 fixed + 8,000 variable; no check-in
    expect(await metric(U.ownerA, "net_profit")).toMatchObject({ value: 1_000 });
    expect(await metric(U.ownerA, "avg_ticket_price")).toMatchObject({ value: 300 });
    expect(await metric(U.ownerA, "eligible_nonlocal_financed_local_spend")).toMatchObject({ value: 21_000 });
    expect((await metric(U.ownerA, "break_even_attendees")).note).toMatch(/check-in yok/);
    const staff = await metric(U.staffA, "net_profit");
    expect(staff).toMatchObject({ value: null, reason: "no_data" });
    expect(staff.note).toMatch(/yalnızca kurum sahibi/);
  });

  it("CSV export: owner/admin; Turkish decimals; formulas neutralised", async () => {
    as(U.ownerA);
    await budgetRoute.POST(send("POST", { organizationId: ORG_A, kind: "COST", category: "OTHER", label: "=HYPERLINK(\"x\")", actual: 1_234.5,
      costBehavior: "FIXED", supplierLocal: false, fundedExternally: false }), P({ eventId: ev }));
    const r = await exportRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }));
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"1234,50"');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    as(U.staffA);
    expect((await exportRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
  });

  it("delete; deleting the event removes its lines", async () => {
    as(U.ownerA);
    expect((await itemRoute.DELETE(get({ organizationId: ORG_A }), P({ itemId: venueId }))).status).toBe(204);
    expect((await itemRoute.DELETE(get({ organizationId: ORG_A }), P({ itemId: venueId }))).status).toBe(404);
    await ctx.pg.query("delete from events where id = $1", [ev]);
    expect((await ctx.pg.query("select count(*)::int as n from budget_items where event_id = $1", [ev])).rows[0]).toEqual({ n: 0 });
    expect(evB).not.toBe("");
  });
});
