/**
 * Survey spend category → CPA A64 products (a design decision, "T" in the KPI reference; versioned here and shown
 * on the multiplier-set page). Single-product categories go to the product that sells that service; mixed
 * categories are spread over their products in proportion to Turkish households' own purchases of them
 * (TÜİK 2023 use table, household final consumption at purchasers' prices) — no hand-set weights.
 */
import type { SpendCategoryValue } from "@/lib/metrics/question-bank";
import type { IoTables } from "@/lib/io/engine";

export const SPEND_MAPPING_VERSION = "spend-mapping/1.0.0" as const;

type Rule = { label: string; products: readonly string[] } | { label: string; prefixes: readonly string[]; exclude?: readonly string[] };

export const SPEND_TO_PRODUCTS: Partial<Record<SpendCategoryValue, Rule>> = {
  ACCOMMODATION: { label: "I — Konaklama ve yiyecek hizmetleri", products: ["I"] },
  FOOD_BEVERAGE: { label: "I — Konaklama ve yiyecek hizmetleri (yerinde yeme-içme)", products: ["I"] },
  LOCAL_TRANSPORT: { label: "H49 — Kara taşımacılığı (taksi, otobüs, dolmuş)", products: ["H49"] },
  RETAIL_SHOPPING: { label: "A01–C33 mal ürünleri, hanehalkı alım yapısına göre", prefixes: ["A", "B", "C"] },
  ENTERTAINMENT_CULTURE: { label: "R90–R92 ve R93, hanehalkı alım yapısına göre", products: ["R90-R92", "R93"] },
  OTHER: { label: "Tüm ürünler, hanehalkı alım yapısına göre (izafi kira ve ev hizmetleri hariç)", prefixes: [""], exclude: ["L68A", "T"] },
};

/** Product weights (Σ = 1) for a category; mixed categories weighted by household purchases. */
export function productWeights(t: IoTables, category: SpendCategoryValue): Record<string, number> | null {
  const rule = SPEND_TO_PRODUCTS[category];
  if (!rule) return null;
  const codes = "products" in rule
    ? [...rule.products]
    : t.products.map((p) => p.code).filter((c) => rule.prefixes.some((pre) => c.startsWith(pre)) && !(rule.exclude ?? []).includes(c));
  const idx = new Map(t.products.map((p, i) => [p.code, i]));
  const raw = codes.map((c) => [c, Math.max(0, t.household.purchasers[idx.get(c)!]!)] as const).filter(([, v]) => v > 0);
  const total = raw.reduce((s, [, v]) => s + v, 0);
  return Object.fromEntries(raw.map(([c, v]) => [c, v / total]));
}
