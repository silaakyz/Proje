/**
 * External data sources (migration 0013) through their Route Handlers on a migrated database, with the network
 * replaced by a stub: configuration and permissions, pulls (stored observations, recorded errors without
 * credentials, a changed configuration dropping old data), press-mention review, CSV uploads, metrics computed from
 * all of it, and the automatic pull's claiming.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dataObservations, events } from "@/db/schema";
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

const sourcesRoute = await import("@/app/api/events/[eventId]/data-sources/route");
const pullRoute = await import("@/app/api/events/[eventId]/data-sources/pull/route");
const sourceRoute = await import("@/app/api/data-sources/[sourceId]/route");
const mentionsRoute = await import("@/app/api/events/[eventId]/mentions/route");
const mentionRoute = await import("@/app/api/mentions/[mentionId]/route");
const uploadsRoute = await import("@/app/api/events/[eventId]/uploads/route");
const uploadRoute = await import("@/app/api/events/[eventId]/uploads/[kind]/route");
const metricsRoute = await import("@/app/api/events/[eventId]/metrics/route");
const svc = await import("@/server/connectors/data-sources-service");

let ctx: Awaited<ReturnType<typeof setupDb>>;
let ev = "";
const as = (user: string | null) => { h.user = user; };
const send = (method: string, body?: unknown) =>
  new Request("http://test.local/api", { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (q: Record<string, string>) => new Request(`http://test.local/api?${new URLSearchParams(q)}`);
const P = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: r.status === 204 ? null : await r.json() });
const day = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date(Date.now() + n * 86_400_000));
const metric = async (user: string, id: string) => {
  as(user);
  const r = await json(await metricsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })));
  return r.body.values.find((v: { id: string }) => v.id === id);
};
const sources = async () => (await json(await sourcesRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body;

/** Network stub: Open-Meteo, Brevo, GDELT and Google News in their documented formats. */
function network() {
  return vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.hostname.startsWith("geocoding")) return Response.json({ results: [{ name: "İzmir", latitude: 38.41, longitude: 27.13, country_code: "TR" }] });
    if (u.hostname.startsWith("air-quality")) return Response.json({ hourly: { time: [`${day(-2)}T12:00`, `${day(-2)}T13:00`], pm2_5: [4, 30], ozone: [50, 50] } });
    if (u.hostname === "api.brevo.com") {
      return new Response(JSON.stringify({ message: `Key xkeysib-test-secret-1 not found for https://api.brevo.com?key=xkeysib-test-secret-1` }), { status: 401 });
    }
    if (u.hostname === "api.gdeltproject.org") {
      return Response.json({ articles: [{ url: "https://haber.example/kordon-1", title: "Kordon başladı", seendate: "20261020T080000Z", domain: "haber.example" }] });
    }
    if (u.hostname === "news.google.com") {
      return new Response(`<rss><channel><item><title>Kordon Festivali</title><link>https://news.google.com/rss/articles/x1</link></item></channel></rss>`);
    }
    return new Response("not found", { status: 404 });
  });
}

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  ev = (await ctx.db.insert(events).values({
    organizationId: ORG_A, title: "Kordon Gastronomi Festivali", startDate: day(-2), endDate: day(-1),
    aiConfig: { event: { city: "İzmir", dailyStartTime: "12:00", dailyEndTime: "22:00" } }, aiConfigVersion: "blueprint/v1",
  }).returning({ id: events.id }))[0]!.id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("data sources", () => {
  it("every member sees the providers and which server keys are missing (names only); other tenants do not", async () => {
    vi.stubEnv("BREVO_API_KEY", "");
    as(U.staffA);
    const body = await sources();
    expect(body.providers.map((p: { provider: string }) => p.provider)).toEqual(["OPEN_METEO_AIR", "BREVO", "GA4", "META", "YOUTUBE", "NEWS"]);
    expect(body.providers.find((p: { provider: string }) => p.provider === "BREVO")).toMatchObject({ missingEnv: ["BREVO_API_KEY"], source: null });
    expect(body.providers.find((p: { provider: string }) => p.provider === "OPEN_METEO_AIR").missingEnv).toEqual([]);
    as(U.ownerB);
    expect((await sourcesRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
  });

  it("owner/admin configure sources; the configuration is validated per provider", async () => {
    as(U.staffA);
    expect((await sourcesRoute.PUT(send("PUT", { organizationId: ORG_A, provider: "OPEN_METEO_AIR", config: {} }), P({ eventId: ev }))).status).toBe(403);
    as(U.ownerA);
    expect((await sourcesRoute.PUT(send("PUT", { organizationId: ORG_A, provider: "BREVO", config: { campaignIds: ["x"] } }), P({ eventId: ev }))).status).toBe(400);
    expect((await sourcesRoute.PUT(send("PUT", { organizationId: ORG_A, provider: "TWITTER", config: {} }), P({ eventId: ev }))).status).toBe(400);
    for (const [provider, config] of [["OPEN_METEO_AIR", {}], ["BREVO", { campaignIds: ["12"] }], ["NEWS", {}]] as const) {
      expect((await sourcesRoute.PUT(send("PUT", { organizationId: ORG_A, provider, config }), P({ eventId: ev }))).status).toBe(200);
    }
    as(U.ownerB);
    expect((await sourcesRoute.PUT(send("PUT", { organizationId: ORG_B, provider: "NEWS", config: {} }), P({ eventId: ev }))).status).toBe(404);
  });

  it("a pull stores observations and feeds the metrics; a failing provider records its error without the key", async () => {
    vi.stubGlobal("fetch", network());
    vi.stubEnv("BREVO_API_KEY", "xkeysib-test-secret-1");
    as(U.staffA);
    expect((await pullRoute.POST(send("POST", { organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
    as(U.ownerA);
    const r = await json(await pullRoute.POST(send("POST", { organizationId: ORG_A }), P({ eventId: ev })));
    expect(r.body.results.map((x: { provider: string; status: string }) => [x.provider, x.status])).toEqual([["BREVO", "ERROR"], ["NEWS", "OK"], ["OPEN_METEO_AIR", "OK"]]);
    const brevo = (await sources()).providers.find((p: { provider: string }) => p.provider === "BREVO").source;
    expect(brevo).toMatchObject({ lastStatus: "ERROR" });
    expect(brevo.lastError).toMatch(/^HTTP 401/);
    expect(brevo.lastError).not.toContain("xkeysib-test-secret-1");
    // air: 12:00 good (pm2.5 4, ozone 50), 13:00 moderate (pm2.5 30)
    expect(await metric(U.staffA, "air_quality_good_fair_share")).toMatchObject({ value: 50, n: 2 });
    expect(await metric(U.staffA, "air_quality_worst_level")).toMatchObject({ value: 3 });
    expect(await metric(U.staffA, "pm25_event_mean")).toMatchObject({ value: 17 });
    expect(await metric(U.staffA, "email_open_rate")).toMatchObject({ value: null });
  });

  it("press candidates are counted only after a person verifies them; a clipping can be added by hand", async () => {
    expect(await metric(U.staffA, "media_coverage_count")).toMatchObject({ value: 0, note: expect.stringMatching(/aday: 2/) });
    as(U.staffA);
    const list = (await json(await mentionsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body.mentions;
    expect(list.map((m: { url: string; status: string }) => [m.url, m.status]).sort()).toEqual([
      ["https://haber.example/kordon-1", "CANDIDATE"], ["https://news.google.com/rss/articles/x1", "CANDIDATE"]]);
    const gdelt = list.find((m: { foundBy: string }) => m.foundBy === "GDELT");
    expect((await mentionRoute.PATCH(send("PATCH", { organizationId: ORG_A, status: "VERIFIED" }), P({ mentionId: gdelt.id }))).status).toBe(403);
    as(U.ownerA);
    expect((await mentionRoute.PATCH(send("PATCH", { organizationId: ORG_A, status: "VERIFIED" }), P({ mentionId: gdelt.id }))).status).toBe(200);
    const added = await mentionsRoute.POST(send("POST", { organizationId: ORG_A, url: "https://gazete.example/kordon", title: "Kordon'da lezzet" }), P({ eventId: ev }));
    expect(added.status).toBe(201);
    expect(await json(await mentionsRoute.POST(send("POST", { organizationId: ORG_A, url: "https://gazete.example/kordon" }), P({ eventId: ev })))).toMatchObject({ status: 409, body: { code: "MENTION_EXISTS" } });
    expect((await mentionsRoute.POST(send("POST", { organizationId: ORG_A, url: "javascript:alert(1)" }), P({ eventId: ev }))).status).toBe(400);
    expect(await metric(U.staffA, "media_coverage_count")).toMatchObject({ value: 2 });
    // a later pull keeps the review
    vi.stubGlobal("fetch", network());
    as(U.ownerA);
    await pullRoute.POST(send("POST", { organizationId: ORG_A, provider: "NEWS" }), P({ eventId: ev }));
    expect(await metric(U.staffA, "media_coverage_count")).toMatchObject({ value: 2 });
  });

  it("a changed configuration drops what the old one pulled; a paused source stops feeding metrics; delete removes its data", async () => {
    as(U.ownerA);
    const air = (await sources()).providers.find((p: { provider: string }) => p.provider === "OPEN_METEO_AIR").source;
    expect(air.observations).toBeGreaterThan(0);
    await sourcesRoute.PUT(send("PUT", { organizationId: ORG_A, provider: "OPEN_METEO_AIR", config: {}, enabled: false }), P({ eventId: ev }));
    expect(await metric(U.ownerA, "air_quality_worst_level")).toMatchObject({ value: null });
    await sourcesRoute.PUT(send("PUT", { organizationId: ORG_A, provider: "OPEN_METEO_AIR", config: {}, enabled: true }), P({ eventId: ev }));
    expect(await metric(U.ownerA, "air_quality_worst_level")).toMatchObject({ value: 3 }); // same config: data kept
    await sourcesRoute.PUT(send("PUT", { organizationId: ORG_A, provider: "OPEN_METEO_AIR", config: { city: "Manisa" } }), P({ eventId: ev }));
    const changed = (await sources()).providers.find((p: { provider: string }) => p.provider === "OPEN_METEO_AIR").source;
    expect(changed).toMatchObject({ observations: 0, lastStatus: null, config: { city: "Manisa" } });
    as(U.ownerB);
    expect((await sourceRoute.DELETE(get({ organizationId: ORG_B }), P({ sourceId: changed.id }))).status).toBe(404);
    as(U.ownerA);
    expect((await sourceRoute.DELETE(get({ organizationId: ORG_A }), P({ sourceId: changed.id }))).status).toBe(204);
  });

  it("automatic pulls claim each due source once", async () => {
    vi.stubGlobal("fetch", network());
    await ctx.pg.query("update event_data_sources set last_sync_at = now() - interval '2 hours'");
    const first = await svc.pullDueSources(60);
    expect(first.map((r) => r.provider).sort()).toEqual(["BREVO", "NEWS"]);
    expect(await svc.pullDueSources(60)).toEqual([]); // just pulled
    // an event outside its window is not pulled
    await ctx.pg.query("update events set start_date = $2, end_date = $2 where id = $1", [ev, day(120)]);
    await ctx.pg.query("update event_data_sources set last_sync_at = null");
    expect(await svc.pullDueSources(60)).toEqual([]);
    await ctx.pg.query("update events set start_date = $2, end_date = $3 where id = $1", [ev, day(-2), day(-1)]);
  });
});

describe("sponsor and lead uploads", () => {
  const SPONSORS = "sponsor;bu_edisyon;onceki_edisyon;maliyet_tl;atfedilen_deger_tl;gosterim\nA;evet;evet;100000;150000;1000000\nB;hayır;evet;;;\n";
  const LEADS = "lead_id;ad_soyad;stant;izin;nitelikli;firsat;firsat_degeri_tl\nL1;Ayşe Yılmaz;X;evet;evet;evet;5000\nL2;Ali Veli;X;evet;evet;hayır;\n";

  it("owner/admin replace the lists; personal columns never reach the database; staff sees counts, not money", async () => {
    as(U.staffA);
    expect((await uploadRoute.POST(send("POST", { organizationId: ORG_A, csv: SPONSORS }), P({ eventId: ev, kind: "sponsors" }))).status).toBe(403);
    expect((await uploadsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev }))).status).toBe(403);
    as(U.ownerA);
    expect((await uploadRoute.POST(send("POST", { organizationId: ORG_A, csv: SPONSORS }), P({ eventId: ev, kind: "other" }))).status).toBe(404);
    expect(await json(await uploadRoute.POST(send("POST", { organizationId: ORG_A, csv: SPONSORS }), P({ eventId: ev, kind: "sponsors" }))))
      .toMatchObject({ status: 200, body: { stored: 2, issues: [] } });
    const leads = await json(await uploadRoute.POST(send("POST", { organizationId: ORG_A, csv: LEADS }), P({ eventId: ev, kind: "leads" })));
    expect(leads).toMatchObject({ status: 200, body: { stored: 2, droppedColumns: ["ad_soyad"] } });
    const stored = await ctx.pg.query("select * from event_leads where event_id = $1", [ev]);
    expect(JSON.stringify(stored.rows)).not.toMatch(/Ayşe|Ali Veli/);
    expect((await json(await uploadsRoute.GET(get({ organizationId: ORG_A }), P({ eventId: ev })))).body)
      .toMatchObject({ sponsors: { rows: 2, currentEdition: 1 }, leads: { rows: 2, exhibitors: 1 } });
    expect(await metric(U.ownerA, "sponsor_roi")).toMatchObject({ value: 50 });
    expect(await metric(U.ownerA, "sponsor_renewal_rate")).toMatchObject({ value: 50 });
    expect(await metric(U.ownerA, "leads_count")).toMatchObject({ value: 2 });
    expect(await metric(U.staffA, "leads_count")).toMatchObject({ value: 2 });
    expect(await metric(U.staffA, "sponsor_roi")).toMatchObject({ value: null });
  });

  it("an invalid file stores nothing and lists every problem (422)", async () => {
    as(U.ownerA);
    const r = await json(await uploadRoute.POST(send("POST", { organizationId: ORG_A, csv: "lead_id;izin;nitelikli;firsat\nL9;evet;evet;belki\nali@x.com;evet;evet;hayır\n" }),
      P({ eventId: ev, kind: "leads" })));
    expect(r).toMatchObject({ status: 422, body: { code: "CSV_INVALID", stored: 0 } });
    expect(r.body.issues.map((i: { line: number }) => i.line)).toEqual([2, 3]);
    expect(await metric(U.ownerA, "leads_count")).toMatchObject({ value: 2 }); // the previous list stays
    expect((await uploadRoute.DELETE(get({ organizationId: ORG_A }), P({ eventId: ev, kind: "leads" }))).status).toBe(204);
    expect(await metric(U.ownerA, "leads_count")).toMatchObject({ value: null });
  });

  it("the browser roles have no privilege on the new tables; observations must be finite", async () => {
    for (const t of ["event_data_sources", "data_observations", "media_mentions", "event_sponsors", "event_leads"]) {
      expect(await outcome(ctx.as(U.ownerA, (tx) => tx.execute(`select * from ${t}` as never))), t).toMatch(/permission denied/);
    }
    const [src] = await ctx.pg.query<{ id: string }>("select id from event_data_sources limit 1").then((r) => r.rows);
    expect(await outcome(ctx.db.insert(dataObservations).values({ organizationId: ORG_A, eventId: ev, sourceId: src!.id, key: "x", value: Number.NaN })))
      .toMatch(/data_observations_value_finite/);
  });
});
