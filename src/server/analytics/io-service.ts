/**
 * Multiplier sets computed from TÜİK's 2023 input-output tables (src/lib/io): national Type I, or regionalised
 * with FLQ when the organization supplies its region's activity by A10 section and a sourced δ. The result is
 * stored as an ordinary multiplier set (immutable, with its source text), so the impact engine and its gate treat
 * it like any other: a national set never qualifies for a regional impact (document §4.4).
 */
import "server-only";
import { z } from "zod";
import { A10_SECTIONS, bridgeToDomesticBasic, effects, flqCoefficients, IO_ENGINE_VERSION, leontiefInverse, locationQuotients,
  technicalCoefficients, TUIK_2023, type A10Key } from "@/lib/io/engine";
import { productWeights, SPEND_MAPPING_VERSION, SPEND_TO_PRODUCTS } from "@/lib/io/spend-mapping";
import type { SpendCategoryValue } from "@/lib/metrics/question-bank";
import { createMultiplierSet } from "@/server/analytics/impact-service";
import { ApiError } from "@/server/http";

const a10Values = z.object(Object.fromEntries(A10_SECTIONS.map((s) => [s.key, z.number().nonnegative()])) as Record<A10Key, z.ZodNumber>);

export const ioRegionSchema = z.object({
  nuts2Code: z.string().regex(/^TR[1-9A-C][0-9]$/),
  /** FLQ δ, 0 ≤ δ < 1, with where it comes from (document: estimate region-specifically). */
  delta: z.number().min(0).lt(1),
  deltaSource: z.string().trim().min(10).max(500),
  regional: a10Values,
  national: a10Values,
  /** Where the A10 figures come from (e.g. "TÜİK Bölgesel Hesaplar, İBBS-2 GSKD, A10, 2023, cari fiyatlarla"). */
  dataSource: z.string().trim().min(10).max(500),
});

export const ioPreviewSchema = z.object({ organizationId: z.uuid(), region: ioRegionSchema.nullable().default(null) });
export const ioCreateSchema = ioPreviewSchema.extend({ name: z.string().trim().min(1).max(200) });

let nationalL: number[][] | undefined;
const nationalA = () => technicalCoefficients(TUIK_2023.Z, TUIK_2023.output);

export function ioMultipliers(region: z.infer<typeof ioRegionSchema> | null) {
  let L: number[][];
  let regionInfo: null | { lambda: number; regionalShare: number; slqA10: Record<A10Key, number> } = null;
  try {
    if (region) {
      const lq = locationQuotients(TUIK_2023.products, region);
      L = leontiefInverse(flqCoefficients(nationalA(), lq.slq, lq.lambda));
      regionInfo = { lambda: lq.lambda, regionalShare: lq.regionalShare, slqA10: lq.slqA10 };
    } else {
      L = nationalL ??= leontiefInverse(nationalA());
    }
  } catch (e) {
    throw new ApiError(422, e instanceof Error ? e.message : String(e), "IO_INVALID");
  }
  const categories = (Object.keys(SPEND_TO_PRODUCTS) as SpendCategoryValue[]).map((category) => {
    const weights = productWeights(TUIK_2023, category)!;
    const bridge = bridgeToDomesticBasic(TUIK_2023, weights);
    const e = effects(TUIK_2023, L, bridge.d);
    return {
      spendCategory: category,
      mapping: SPEND_TO_PRODUCTS[category]!.label,
      a64Code: Object.keys(weights).length === 1 ? Object.keys(weights)[0]! : "mixed",
      output: e.output, valueAdded: e.valueAdded, income: e.income, employmentPerMTry: null,
      bridge: bridge.decomposition,
    };
  });
  return {
    engineVersion: IO_ENGINE_VERSION, mappingVersion: SPEND_MAPPING_VERSION, source: TUIK_2023.source, files: TUIK_2023.files,
    year: TUIK_2023.year, multiplierType: "TYPE_I" as const, method: region ? ("FLQ" as const) : ("NATIONAL" as const), region: regionInfo, categories,
  };
}

/** Stores the computed coefficients as a multiplier set of the organization. */
export async function createIoMultiplierSet(userId: string, input: z.infer<typeof ioCreateSchema>) {
  const r = ioMultipliers(input.region);
  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const source = [
    `${r.source}; ${r.engineVersion}, ${r.mappingVersion}; Tip I, alıcı fiyatından temel fiyata TÜİK hanehalkı köprüsüyle.`,
    input.region ? `FLQ δ = ${input.region.delta} (${input.region.deltaSource}); bölgesel A10 verisi: ${input.region.dataSource}.` : "Ulusal katsayılar.",
    "İstihdam katsayısı yok (tablolar içermiyor).",
  ].join(" ");
  return createMultiplierSet(userId, {
    organizationId: input.organizationId,
    name: input.name,
    source: source.slice(0, 1000),
    ioBaseYear: r.year,
    priceYear: r.year,
    nuts2Code: input.region?.nuts2Code ?? null,
    method: r.method,
    multiplierType: "TYPE_I",
    coefficients: r.categories.map((c) => ({
      spendCategory: c.spendCategory, a64Code: c.a64Code.slice(0, 16), output: round6(c.output), valueAdded: round6(c.valueAdded),
      income: round6(c.income), employmentPerMTry: null,
    })),
  });
}
