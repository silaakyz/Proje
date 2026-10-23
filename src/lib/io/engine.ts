/**
 * Input-output engine (pure, deterministic) on TÜİK's 2023 A64 tables (src/lib/io/data/tuik-2023.json), with the
 * formulas of the organization's KPI reference, §3.11:
 *   A[i,j] = Z_yurtiçi[i,j] / X[j]                       domestic technical coefficient (X[j] = 0 → stop)
 *   L = (I − A)⁻¹; invalid when the spectral radius of A ≥ 1
 *   r[i,j] = A[i,j] × min(FLQ[i,j], 1)                  regional coefficient (FLQ)
 *     FLQ[i,j] = CILQ[i,j] × λ,  CILQ[i,j] = SLQ[i] / SLQ[j] (i = j: SLQ[i]),
 *     SLQ[i] = (regional[i] / regional total) / (national[i] / national total),
 *     λ = [log2(1 + regional total / national total)]^δ   — δ is the organization's sourced input
 *   Δx = L × d;  output multiplier = column sum of L;  GVA effect = Σ vᵢ Δxᵢ;  Type I only (Type II off by default).
 *
 * Purchasers' → basic price bridge (document §4.3: "dönüşüm köprüsünü sen kurmalısın"), built only from TÜİK's
 * household column of the valuation tables: for 1 TRY spent on product p at purchasers' prices,
 *   basic value of p      = basic_p / purchasers_p           (non-margin product)
 *                         = (purchasers_p − taxes_p) / purchasers_p   (margin product bought directly)
 *   margins of p          = margins_p / purchasers_p, spread over the margin products (G45–G47, H49–H52) in
 *                           proportion to how much margin they supply to households (their negative entries)
 *   net product taxes     leave the economy's output
 *   imports               only the domestic share of each product's basic value (domesticBasic / basic) is demand
 *                         on domestic producers; the rest leaks abroad.
 * The result d (per TRY of visitor spend) multiplied by L gives multipliers per TRY of purchasers'-price spend,
 * which is what survey spend is.
 */
import data from "@/lib/io/data/tuik-2023.json";

export const IO_ENGINE_VERSION = "io-engine/1.0.0" as const;

export interface IoTables {
  products: { code: string; name: string }[];
  Z: number[][];
  output: number[];
  gva: number[];
  compensation: number[];
  household: { purchasers: number[]; basic: number[]; domesticBasic: number[]; margins: number[]; taxes: number[] };
}

export const TUIK_2023 = data as unknown as IoTables & { source: string; files: string[]; year: number; unit: string };

export class IoError extends Error {}

export function technicalCoefficients(Z: readonly number[][], X: readonly number[]): number[][] {
  const n = X.length;
  X.forEach((x, j) => {
    if (!(x > 0)) throw new IoError(`X[${j}] = ${x}: output must be positive (document: "X[j] = 0 ise dur")`);
  });
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Z[i]![j]! / X[j]!));
}

/** Spectral radius of a non-negative matrix by power iteration (upper bound check via column sums first). */
export function spectralRadius(A: readonly number[][]): number {
  const n = A.length;
  const maxColSum = Math.max(...Array.from({ length: n }, (_, j) => A.reduce((s, row) => s + Math.abs(row[j]!), 0)));
  if (maxColSum < 1) return maxColSum; // an upper bound below 1 is enough for validity
  let v = Array(n).fill(1 / n);
  let lambda = 0;
  for (let k = 0; k < 500; k++) {
    const w = A.map((row) => row.reduce((s, a, j) => s + a * v[j], 0));
    const norm = Math.max(...w.map(Math.abs));
    if (norm === 0) return 0;
    v = w.map((x) => x / norm);
    if (Math.abs(norm - lambda) < 1e-12) return norm;
    lambda = norm;
  }
  return lambda;
}

/** (I − A)⁻¹ by Gauss–Jordan elimination with partial pivoting. */
export function leontiefInverse(A: readonly number[][]): number[][] {
  const n = A.length;
  const rho = spectralRadius(A);
  if (rho >= 1) throw new IoError(`spectral radius ${rho} ≥ 1: Leontief inverse is not valid (document §3.11)`);
  const M = A.map((row, i) => [...row.map((a, j) => (i === j ? 1 : 0) - a), ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-14) throw new IoError("singular (I − A)");
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]!;
    for (let k = 0; k < 2 * n; k++) M[c]![k]! /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f === 0) continue;
      for (let k = 0; k < 2 * n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row) => row.slice(n));
}

export const matVec = (M: readonly number[][], v: readonly number[]) => M.map((row) => row.reduce((s, m, j) => s + m * v[j]!, 0));

// ------------------------------------------------------------------------------------------- regionalisation

/** A10 sections (TÜİK regional accounts) and the A64 product codes they contain, by CPA section letter. */
export const A10_SECTIONS = [
  { key: "A", name: "Tarım, ormancılık ve balıkçılık", letters: ["A"] },
  { key: "B-E", name: "Sanayi", letters: ["B", "C", "D", "E"] },
  { key: "F", name: "İnşaat", letters: ["F"] },
  { key: "G-I", name: "Ticaret, ulaştırma, konaklama ve yiyecek", letters: ["G", "H", "I"] },
  { key: "J", name: "Bilgi ve iletişim", letters: ["J"] },
  { key: "K", name: "Finans ve sigorta", letters: ["K"] },
  { key: "L", name: "Gayrimenkul", letters: ["L"] },
  { key: "M-N", name: "Mesleki, bilimsel, teknik, idari ve destek hizmetleri", letters: ["M", "N"] },
  { key: "O-Q", name: "Kamu yönetimi, eğitim, sağlık ve sosyal hizmetler", letters: ["O", "P", "Q"] },
  { key: "R-U", name: "Diğer hizmetler", letters: ["R", "S", "T", "U"] },
] as const;
export type A10Key = (typeof A10_SECTIONS)[number]["key"];

export const a10Of = (productCode: string): A10Key => {
  const s = A10_SECTIONS.find((x) => (x.letters as readonly string[]).includes(productCode[0]!));
  if (!s) throw new IoError(`no A10 section for ${productCode}`);
  return s.key;
};

export interface RegionInput {
  /** Regional and national activity by A10 section from one consistent TÜİK source (e.g. GVA by İBBS-2). */
  regional: Record<A10Key, number>;
  national: Record<A10Key, number>;
  delta: number;
}

/** SLQ per product from A10 shares (each A64 product takes its section's SLQ), and λ. */
export function locationQuotients(products: readonly { code: string }[], input: RegionInput) {
  const keys = A10_SECTIONS.map((s) => s.key);
  const regTotal = keys.reduce((s, k) => s + input.regional[k], 0);
  const natTotal = keys.reduce((s, k) => s + input.national[k], 0);
  if (!(regTotal > 0) || !(natTotal > 0) || regTotal > natTotal) throw new IoError("regional total must be positive and not exceed the national total");
  if (!(input.delta >= 0 && input.delta < 1)) throw new IoError("δ must be in [0, 1)");
  const slqA10 = Object.fromEntries(keys.map((k) => {
    if (!(input.national[k] > 0)) throw new IoError(`national ${k} must be positive`);
    return [k, input.regional[k] / regTotal / (input.national[k] / natTotal)];
  })) as Record<A10Key, number>;
  const lambda = Math.log2(1 + regTotal / natTotal) ** input.delta;
  return { slq: products.map((p) => slqA10[a10Of(p.code)]), slqA10, lambda, regionalShare: regTotal / natTotal };
}

/** r[i,j] = A[i,j] × min(FLQ[i,j], 1). */
export function flqCoefficients(A: readonly number[][], slq: readonly number[], lambda: number): number[][] {
  return A.map((row, i) => row.map((a, j) => {
    const cilq = i === j ? slq[i]! : slq[i]! / slq[j]!;
    return a * Math.min(cilq * lambda, 1);
  }));
}

// ------------------------------------------------------------------------------------------- bridge

const MARGIN_PRODUCTS = ["G45", "G46", "G47", "H49", "H50", "H51", "H52"];

/**
 * Domestic basic-price final demand per 1 TRY of household spend at purchasers' prices, for a spend mix given
 * as product weights (Σ = 1). Returns the vector and its decomposition (for the report).
 */
export function bridgeToDomesticBasic(t: IoTables, weights: Readonly<Record<string, number>>) {
  const n = t.products.length;
  const idx = new Map(t.products.map((p, i) => [p.code, i]));
  const h = t.household;
  const marginIdx = MARGIN_PRODUCTS.map((c) => idx.get(c)!).filter((i) => i !== undefined);
  const marginSupply = marginIdx.map((i) => Math.max(0, -h.margins[i]!));
  const marginTotal = marginSupply.reduce((s, x) => s + x, 0);
  const domShare = (i: number) => (h.basic[i]! > 0 ? h.domesticBasic[i]! / h.basic[i]! : 0);

  const d = Array(n).fill(0) as number[];
  let basic = 0, margins = 0, taxes = 0, imports = 0;
  const wSum = Object.values(weights).reduce((s, w) => s + w, 0);
  if (Math.abs(wSum - 1) > 1e-9) throw new IoError(`product weights must sum to 1 (got ${wSum})`);
  for (const [code, w] of Object.entries(weights)) {
    const i = idx.get(code);
    if (i === undefined) throw new IoError(`unknown product ${code}`);
    const P = h.purchasers[i]!;
    if (!(P > 0)) throw new IoError(`households buy no ${code} at purchasers' prices`);
    const isMargin = MARGIN_PRODUCTS.includes(code);
    const basicShare = isMargin ? (P - h.taxes[i]!) / P : h.basic[i]! / P;
    const marginShare = isMargin ? 0 : h.margins[i]! / P;
    const taxShare = h.taxes[i]! / P;
    d[i] = d[i]! + w * basicShare * domShare(i);
    basic += w * basicShare;
    imports += w * basicShare * (1 - domShare(i));
    taxes += w * taxShare;
    if (marginShare > 0 && marginTotal > 0) {
      margins += w * marginShare;
      marginIdx.forEach((m, k) => {
        const part = w * marginShare * (marginSupply[k]! / marginTotal);
        d[m] = d[m]! + part * domShare(m);
        imports += part * (1 - domShare(m));
      });
    }
  }
  return { d, decomposition: { basic, margins, taxes, imports, domesticDemand: d.reduce((s, x) => s + x, 0) } };
}

/** Output, GVA and compensation (income) effects per 1 TRY of the given final demand vector. */
export function effects(t: IoTables, L: readonly number[][], d: readonly number[]) {
  const dx = matVec(L, d);
  const v = t.gva.map((g, i) => g / t.output[i]!);
  const w = t.compensation.map((c, i) => c / t.output[i]!);
  return {
    output: dx.reduce((s, x) => s + x, 0),
    valueAdded: dx.reduce((s, x, i) => s + v[i]! * x, 0),
    income: dx.reduce((s, x, i) => s + w[i]! * x, 0),
    direct: d.reduce((s, x) => s + x, 0),
  };
}
