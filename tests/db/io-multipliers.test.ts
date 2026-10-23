/**
 * Multiplier sets from TÜİK's 2023 input-output tables (src/server/analytics/io-service.ts) through their Route
 * Handlers on a migrated database: preview for members, storing for impact managers, national vs FLQ, no
 * employment coefficient. The regional figures below are test values, not TÜİK data.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ORG_A, ORG_B, setupDb, U } from "./helpers";

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

const previewRoute = await import("@/app/api/io/tuik-2023/route");
const fromIoRoute = await import("@/app/api/multiplier-sets/from-io/route");
const setsRoute = await import("@/app/api/multiplier-sets/route");

let ctx: Awaited<ReturnType<typeof setupDb>>;
const as = (user: string | null) => { h.user = user; };
const send = (body: unknown) => new Request("http://test.local/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (q: Record<string, string>) => new Request(`http://test.local/api?${new URLSearchParams(q)}`);
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

const KEYS = ["A", "B-E", "F", "G-I", "J", "K", "L", "M-N", "O-Q", "R-U"] as const;
const national = Object.fromEntries(KEYS.map((k) => [k, 100])) as Record<string, number>;
// A region with 10% of the country and twice the national share in G-I (trade, transport, accommodation).
const regional = Object.fromEntries(KEYS.map((k) => [k, k === "G-I" ? 19 : 9])) as Record<string, number>;
const region = {
  nuts2Code: "TR31", delta: 0.3, deltaSource: "Test değeri — kaynaklı bir tahmin değildir",
  regional, national, dataSource: "Test verisi — TÜİK bölgesel hesapları değildir",
};

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
});

describe("TÜİK 2023 multiplier sets", () => {
  it("preview: members see national Type I multipliers ≥ 1 with the purchasers' → basic bridge; other tenants are refused", async () => {
    as(null);
    expect((await previewRoute.POST(send({ organizationId: ORG_A, region: null }))).status).toBe(401);
    as(U.ownerB);
    expect((await previewRoute.POST(send({ organizationId: ORG_A, region: null }))).status).toBe(403);
    as(U.staffA);
    const r = await json(await previewRoute.POST(send({ organizationId: ORG_A, region: null })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ method: "NATIONAL", multiplierType: "TYPE_I", year: 2023, region: null });
    expect(r.body.categories).toHaveLength(6);
    for (const c of r.body.categories) {
      expect(c.employmentPerMTry).toBeNull();
      expect(c.output).toBeGreaterThan(1);
      expect(c.valueAdded).toBeLessThan(c.output);
      expect(c.income).toBeLessThan(c.valueAdded);
      // every TRY of spend is basic value (domestic or imported), margins or product taxes
      expect(c.bridge.basic + c.bridge.margins + c.bridge.taxes).toBeCloseTo(1, 9);
      expect(c.bridge.domesticDemand + c.bridge.imports + c.bridge.taxes).toBeCloseTo(1, 9);
    }
  });

  it("preview with a region: FLQ multipliers stay below the national ones; inconsistent inputs are 400/422", async () => {
    as(U.staffA);
    const nat = (await json(await previewRoute.POST(send({ organizationId: ORG_A, region: null })))).body;
    const r = await json(await previewRoute.POST(send({ organizationId: ORG_A, region })));
    expect(r.status).toBe(200);
    expect(r.body.method).toBe("FLQ");
    expect(r.body.region.regionalShare).toBeCloseTo(0.1, 12);
    expect(r.body.region.slqA10["G-I"]).toBeCloseTo(19 / 100 / 0.1, 12);
    expect(r.body.region.lambda).toBeCloseTo(Math.log2(1.1) ** 0.3, 12);
    // per TRY of purchasers'-price spend: at least the direct domestic demand, at most the national multiplier
    r.body.categories.forEach((c: { output: number; bridge: { domesticDemand: number } }, i: number) => {
      expect(c.output).toBeGreaterThanOrEqual(c.bridge.domesticDemand);
      expect(c.output).toBeLessThan(nat.categories[i].output);
    });
    expect((await previewRoute.POST(send({ organizationId: ORG_A, region: { ...region, delta: 1 } }))).status).toBe(400);
    expect((await previewRoute.POST(send({ organizationId: ORG_A, region: { ...region, deltaSource: "yok" } }))).status).toBe(400);
    const bigger = await json(await previewRoute.POST(send({ organizationId: ORG_A, region: { ...region, regional: { ...regional, A: 1000 } } })));
    expect(bigger).toMatchObject({ status: 422, body: { code: "IO_INVALID" } });
  });

  it("storing: impact managers only; the set carries its source, 2023 years, method and no employment coefficient", async () => {
    as(U.staffA);
    expect((await fromIoRoute.POST(send({ organizationId: ORG_A, name: "TÜİK ulusal", region: null }))).status).toBe(403);
    as(U.ownerA);
    const n = await json(await fromIoRoute.POST(send({ organizationId: ORG_A, name: "TÜİK ulusal", region: null })));
    expect(n.status).toBe(201);
    expect(n.body.multiplierSet).toMatchObject({ method: "NATIONAL", nuts2Code: null, multiplierType: "TYPE_I", ioBaseYear: 2023, priceYear: 2023 });
    expect(n.body.multiplierSet.source).toMatch(/TÜİK/);
    expect(n.body.multiplierSet.source).toMatch(/İstihdam katsayısı yok/);
    const f = await json(await fromIoRoute.POST(send({ organizationId: ORG_A, name: "TÜİK TR31 FLQ", region })));
    expect(f.status).toBe(201);
    expect(f.body.multiplierSet).toMatchObject({ method: "FLQ", nuts2Code: "TR31" });
    expect(f.body.multiplierSet.source).toMatch(/δ = 0.3/);

    as(U.staffA);
    const sets = (await json(await setsRoute.GET(get({ organizationId: ORG_A })))).body.multiplierSets;
    expect(sets).toHaveLength(2);
    for (const s of sets) {
      expect(s.coefficients).toHaveLength(6);
      for (const c of s.coefficients) expect(c.employmentPerMTry).toBeNull();
    }
    const acc = sets.find((s: { method: string }) => s.method === "NATIONAL").coefficients.find((c: { spendCategory: string }) => c.spendCategory === "ACCOMMODATION");
    expect(acc.a64Code).toBe("I");
    as(U.ownerB);
    expect((await json(await setsRoute.GET(get({ organizationId: ORG_B })))).body.multiplierSets).toEqual([]);
  });
});
