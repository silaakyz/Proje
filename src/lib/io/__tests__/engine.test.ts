import { describe, expect, it } from "vitest";
import {
  a10Of, bridgeToDomesticBasic, effects, flqCoefficients, IoError, leontiefInverse, locationQuotients, matVec, spectralRadius,
  technicalCoefficients, TUIK_2023,
} from "../engine";
import { productWeights, SPEND_TO_PRODUCTS } from "../spend-mapping";

describe("Leontief arithmetic (document §3.11)", () => {
  it("2×2 textbook case: A = Z / X and L = (I − A)⁻¹", () => {
    const A = technicalCoefficients([[20, 30], [40, 10]], [100, 100]);
    expect(A).toEqual([[0.2, 0.3], [0.4, 0.1]]);
    const L = leontiefInverse(A);
    const det = 0.8 * 0.9 - 0.3 * 0.4;
    expect(L[0]![0]).toBeCloseTo(0.9 / det, 12);
    expect(L[0]![1]).toBeCloseTo(0.3 / det, 12);
    expect(L[1]![0]).toBeCloseTo(0.4 / det, 12);
    // (I − A) L = I
    const back = [[0.8, -0.3], [-0.4, 0.9]].map((r) => [0, 1].map((j) => r[0]! * L[0]![j]! + r[1]! * L[1]![j]!));
    expect(back[0]![0]).toBeCloseTo(1, 12);
    expect(back[0]![1]).toBeCloseTo(0, 12);
  });

  it("refuses X = 0 and a spectral radius ≥ 1", () => {
    expect(() => technicalCoefficients([[1]], [0])).toThrow(IoError);
    expect(spectralRadius([[0.5, 0.6], [0.6, 0.5]])).toBeCloseTo(1.1, 6);
    expect(() => leontiefInverse([[0.5, 0.6], [0.6, 0.5]])).toThrow(/spectral radius/);
  });

  it("FLQ: r = a × min(CILQ × λ, 1), diagonal uses SLQ", () => {
    const r = flqCoefficients([[0.2, 0.3], [0.4, 0.1]], [0.5, 2], 0.8);
    expect(r[0]![0]).toBeCloseTo(0.2 * 0.5 * 0.8, 12); // SLQ_0 × λ
    expect(r[0]![1]).toBeCloseTo(0.3 * Math.min((0.5 / 2) * 0.8, 1), 12);
    expect(r[1]![0]).toBeCloseTo(0.4 * 1, 12); // (2 / 0.5) × 0.8 = 3.2 → capped at 1
    expect(r[1]![1]).toBeCloseTo(0.1 * 1, 12); // 2 × 0.8 = 1.6 → 1
  });

  it("location quotients and λ from A10 figures", () => {
    const keys = ["A", "B-E", "F", "G-I", "J", "K", "L", "M-N", "O-Q", "R-U"] as const;
    const national = Object.fromEntries(keys.map((k) => [k, 100])) as Record<(typeof keys)[number], number>;
    const regional = { ...Object.fromEntries(keys.map((k) => [k, 5])), "G-I": 15 } as Record<(typeof keys)[number], number>;
    const lq = locationQuotients([{ code: "I" }, { code: "C10-C12" }], { regional, national, delta: 0.3 });
    expect(lq.slqA10["G-I"]).toBeCloseTo((15 / 60) / (100 / 1000), 12);
    expect(lq.slq).toEqual([lq.slqA10["G-I"], lq.slqA10["B-E"]]);
    expect(lq.lambda).toBeCloseTo(Math.log2(1 + 60 / 1000) ** 0.3, 12);
    expect(a10Of("L68A")).toBe("L");
    expect(() => locationQuotients([], { regional, national, delta: 1 })).toThrow(/δ/);
  });
});

describe("TÜİK 2023 tables", () => {
  const A = technicalCoefficients(TUIK_2023.Z, TUIK_2023.output);
  const L = leontiefInverse(A);

  it("64 A64 products; valid Leontief inverse; every output multiplier ≥ 1", () => {
    expect(TUIK_2023.products).toHaveLength(64);
    expect(spectralRadius(A)).toBeLessThan(1);
    for (let j = 0; j < 64; j++) expect(L.reduce((s, r) => s + r[j]!, 0)).toBeGreaterThanOrEqual(1);
    // L (I − A) x = x for a random vector
    const x = TUIK_2023.output.map((_, i) => (i % 7) + 1);
    const ImA = A.map((r, i) => r.map((a, j) => (i === j ? 1 : 0) - a));
    const back = matVec(L, matVec(ImA, x));
    back.forEach((v, i) => expect(v).toBeCloseTo(x[i]!, 6));
  });

  it("the purchasers' → basic bridge accounts for every lira (basic + margins + taxes = 1)", () => {
    for (const c of Object.keys(SPEND_TO_PRODUCTS) as (keyof typeof SPEND_TO_PRODUCTS)[]) {
      const w = productWeights(TUIK_2023, c)!;
      expect(Object.values(w).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
      const b = bridgeToDomesticBasic(TUIK_2023, w);
      expect(b.decomposition.basic + b.decomposition.margins + b.decomposition.taxes).toBeCloseTo(1, 9);
      expect(b.decomposition.domesticDemand + b.decomposition.imports).toBeCloseTo(b.decomposition.basic + b.decomposition.margins, 9);
      const e = effects(TUIK_2023, L, b.d);
      expect(e.output).toBeGreaterThanOrEqual(e.direct);
      expect(e.valueAdded).toBeLessThan(e.output);
      expect(e.income).toBeLessThan(e.valueAdded);
    }
  });
});
