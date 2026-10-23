import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  eventConfigDraftSchema,
  isPublishable,
  normalizeEventConfig,
  type EventConfigDraft,
} from "@/lib/ai/schemas/event-config";
import { PROVINCES, resolveProvince } from "@/lib/geo/tr-provinces";

const TODAY = "2026-10-16";

/** What a well-behaved model should return for the brief's example prompt. */
const izmirSummit: EventConfigDraft = {
  event: {
    title: "İzmir Teknoloji Zirvesi", summary: "İzmir'de 500 kişilik, 3 günlük teknoloji zirvesi.",
    format: "SUMMIT", deliveryMode: "IN_PERSON", primaryLanguage: "tr", bilingual: false,
    city: "Izmir", venueName: null, startDate: null, durationDays: 3,
    dailyStartTime: null, dailyEndTime: null, expectedAttendance: 500, capacity: null,
  },
  ticketTypes: [
    { key: "student", name: "Öğrenci (Ücretsiz)", description: null, pricing: "FREE", priceAmount: 0, currency: "TRY",
      quantity: null, maxPerOrder: null, requiresApproval: true, eligibility: "Geçerli öğrenci belgesi gereklidir.", validDayIndexes: [] },
    { key: "corporate", name: "Kurumsal", description: null, pricing: "PAID", priceAmount: null, currency: "TRY",
      quantity: null, maxPerOrder: null, requiresApproval: false, eligibility: null, validDayIndexes: [] },
  ],
  formFields: [
    { key: "dietary_restrictions", type: "MULTI_SELECT", label: "Beslenme kısıtlamalarınız", labelEn: null, helpText: null,
      required: false, options: [
        { value: "vegetarian", label: "Vejetaryen", labelEn: null },
        { value: "vegan", label: "Vegan", labelEn: null },
        { value: "gluten_free", label: "Glutensiz", labelEn: null },
        { value: "Laktozsuz", label: "Laktozsuz", labelEn: null },
      ], maxLength: null, visibleForTicketKeys: [], isSensitive: true, origin: "EXPLICIT", rationale: "İstendi." },
    { key: "student_id", type: "FILE_UPLOAD", label: "Öğrenci belgesi", labelEn: null, helpText: null, required: true,
      options: null, maxLength: null, visibleForTicketKeys: ["student"], isSensitive: false, origin: "INFERRED", rationale: "Uygunluk." },
    { key: "email", type: "EMAIL", label: "E-posta", labelEn: null, helpText: null, required: true, options: null,
      maxLength: null, visibleForTicketKeys: [], isSensitive: false, origin: "EXPLICIT", rationale: "" },
  ],
  clarifications: [],
  assumptions: ["Başlık açıklamadan oluşturuldu."],
};

describe("provinces", () => {
  it("has 81 unique plates across 26 NUTS-2 regions", () => {
    expect(new Set(PROVINCES.map((p) => p.code)).size).toBe(81);
    expect(PROVINCES.every((p, i) => p.code === i + 1)).toBe(true);
    expect(new Set(PROVINCES.map((p) => p.nuts2)).size).toBe(26);
  });
  it.each([["İzmir", 35], ["IZMIR", 35], ["izmir", 35], ["Istanbul", 34], ["Şanlıurfa", 63], ["Urfa", 63], ["Iğdır", 76], ["Eskisehir", 26]])(
    "resolves %s", (name, code) => expect(resolveProvince(name)?.code).toBe(code));
});

describe("normalizeEventConfig", () => {
  const r = normalizeEventConfig(izmirSummit, { today: TODAY });

  it("produces a valid config", () => {
    if (!r.ok) console.error(JSON.stringify(z.treeifyError(r.error), null, 2));
    expect(r.ok).toBe(true);
  });
  if (!r.ok) return;
  const c = r.config;

  it("resolves region deterministically", () => {
    expect(c.event).toMatchObject({ city: "İzmir", provinceCode: 35, nuts2Code: "TR31", slug: "izmir-teknoloji-zirvesi" });
  });
  it("blocks publishing on missing date and price", () => {
    expect(c.clarifications.map((x) => x.path).sort()).toEqual(["event.startDate", "ticketTypes.corporate.priceAmount"]);
    expect(isPublishable(c)).toBe(false);
  });
  it("drops reserved fields, injects KVKK consent, slugs option values", () => {
    expect(c.formFields.map((f) => f.key)).toEqual(["dietary_restrictions", "student_id", "kvkk_special_consent"]);
    expect(c.formFields[0]?.options?.map((o) => o.value)).toContain("laktozsuz");
    expect(c.formFields.at(-1)).toMatchObject({ type: "KVKK_CONSENT", required: true, origin: "SYSTEM" });
  });
  it("keeps prices in minor units", () => {
    expect(c.ticketTypes.map((t) => t.priceAmountMinor)).toEqual([0, null]);
  });
  it("derives endDate once a date is given", () => {
    const withDate = normalizeEventConfig(
      { ...izmirSummit, event: { ...izmirSummit.event, startDate: "2027-04-20" } }, { today: TODAY });
    expect(withDate.ok && withDate.config.event.endDate).toBe("2027-04-22");
  });
  it("rejects past dates instead of trusting them", () => {
    const past = normalizeEventConfig({ ...izmirSummit, event: { ...izmirSummit.event, startDate: "2025-01-01" } }, { today: TODAY });
    expect(past.ok && past.config.event.startDate).toBe(null);
  });
  it("converts a stated TRY price to kuruş", () => {
    const priced = normalizeEventConfig({ ...izmirSummit, ticketTypes: izmirSummit.ticketTypes.map((t) =>
      t.key === "corporate" ? { ...t, priceAmount: 4999.9 } : t) }, { today: TODAY });
    expect(priced.ok && priced.config.ticketTypes[1]?.priceAmountMinor).toBe(499990);
  });
});

describe("provider JSON Schema", () => {
  const js = z.toJSONSchema(eventConfigDraftSchema) as Record<string, unknown>;
  // Visits schema nodes only — a `properties` map is keyed by field names (e.g. our "format" field).
  const walk = (n: unknown, visit: (o: Record<string, unknown>) => void): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((v) => walk(v, visit));
    const o = n as Record<string, unknown>;
    visit(o);
    for (const [k, v] of Object.entries(o)) {
      if (k === "properties" && v && typeof v === "object") Object.values(v).forEach((p) => walk(p, visit));
      else walk(v, visit);
    }
  };
  it("marks every property required (strict-mode compatible)", () => {
    walk(js, (o) => {
      if (o.type === "object" && o.properties)
        expect((o.required as string[]).sort()).toEqual(Object.keys(o.properties as object).sort());
    });
  });
  it("uses no keywords that providers reject or drop", () => {
    const banned = ["pattern", "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"];
    walk(js, (o) => banned.forEach((k) => expect(o).not.toHaveProperty(k)));
  });
  it("accepts the few-shot example", async () => {
    const { buildEventBuilderSystemPrompt } = await import("@/lib/ai/prompts/event-builder");
    const sys = buildEventBuilderSystemPrompt({ today: TODAY, orgName: "X" });
    const example = JSON.parse(sys.split("<response>")[1]!.split("</response>")[0]!);
    expect(eventConfigDraftSchema.safeParse(example).success).toBe(true);
    const n = normalizeEventConfig(example, { today: TODAY });
    expect(n.ok).toBe(true);
  });
});
