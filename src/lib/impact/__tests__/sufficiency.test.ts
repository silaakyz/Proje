import { describe, expect, it } from "vitest";
import { assessImpactSufficiency, type SufficiencyInput } from "@/lib/impact/sufficiency";

const full: SufficiencyInput = {
  requestedLevel: "ECONOMIC_IMPACT",
  attendance: { basis: "CHECKIN", value: 42_000 },
  responses: { nonResidentWithSpend: 400, withAttributionAnswers: 380 },
  assumptions: {
    priceYear: 2027,
    deadweight: { value: 0.18, source: "Ziyaretçi anketi: q_would_visit_anyway = yes oranı" },
    displacement: { value: 0.1, source: "Yöntem kararı 2027-03, belediye ile mutabık" },
    leakage: { value: 0.25, source: "TR62 FLQ bölgeselleştirme çıktısı" },
  },
  eventNuts2Code: "TR62",
  multiplierSet: { id: "ms-1", nuts2Code: "TR62", isActive: true, method: "FLQ" },
};

describe("impact sufficiency gate", () => {
  it("reaches ECONOMIC_IMPACT only when every input and sourced assumption exists", () => {
    const r = assessImpactSufficiency(full);
    expect(r).toMatchObject({ achievedLevel: "ECONOMIC_IMPACT", status: "SUCCEEDED" });
  });
  it("no multiplier set → stops at ATTRIBUTABLE_SPEND, INSUFFICIENT_DATA, with the failing check named", () => {
    const r = assessImpactSufficiency({ ...full, multiplierSet: null });
    expect(r).toMatchObject({ achievedLevel: "ATTRIBUTABLE_SPEND", status: "INSUFFICIENT_DATA" });
    expect(r.checks.filter((c) => !c.passed).map((c) => c.check)).toEqual(["multiplier_set_active", "multiplier_set_matches_region"]);
  });
  it("a national (non-regional) set does not qualify for a regional economic impact", () => {
    const r = assessImpactSufficiency({ ...full, multiplierSet: { id: "n", nuts2Code: null, isActive: true, method: "NATIONAL" } });
    expect(r.achievedLevel).toBe("ATTRIBUTABLE_SPEND");
  });
  it("an assumption without a source is not an assumption: net levels blocked", () => {
    const r = assessImpactSufficiency({ ...full, assumptions: { ...(full.assumptions as object), displacement: { value: 0.1, source: "" } } });
    expect(r.achievedLevel).toBeNull();
    expect(r.status).toBe("INSUFFICIENT_DATA");
  });
  it("organizer-estimated attendance supports gross spend only", () => {
    const r = assessImpactSufficiency({ ...full, attendance: { basis: "ORGANIZER_ESTIMATE", value: 60_000 } });
    expect(r.achievedLevel).toBe("SPEND");
  });
  it("too few responses → nothing reported", () => {
    const r = assessImpactSufficiency({ ...full, responses: { nonResidentWithSpend: 40, withAttributionAnswers: 40 } });
    expect(r).toMatchObject({ achievedLevel: null, status: "INSUFFICIENT_DATA" });
    expect(r.checks.find((c) => c.check === "min_spend_responses")).toMatchObject({ required: 150, actual: 40, passed: false });
  });
  it("never exceeds the requested level", () => {
    expect(assessImpactSufficiency({ ...full, requestedLevel: "SPEND" })).toMatchObject({ achievedLevel: "SPEND", status: "SUCCEEDED" });
  });
});
