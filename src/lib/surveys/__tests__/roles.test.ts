import { describe, expect, it } from "vitest";
import { combinedQuestions, defaultRoutes, effectiveRoutes, routesSchema } from "../roles";

describe("survey flow options", () => {
  it("defaults: one option per audience with a survey; the visitor option also opens the residents survey", () => {
    expect(defaultRoutes(["RESIDENT", "ATTENDEE", "SPONSOR"]).map((r) => [r.key, r.audiences])).toEqual([
      ["attendee", ["ATTENDEE", "RESIDENT"]], ["sponsor", ["SPONSOR"]], ["resident", ["RESIDENT"]],
    ]);
    expect(defaultRoutes(["ATTENDEE"])[0]!.audiences).toEqual(["ATTENDEE"]);
  });

  it("saved options drop audiences without a survey and options left empty", () => {
    const saved = [{ key: "a", label: "A", audiences: ["ATTENDEE", "RESIDENT"] as const }, { key: "b", label: "B", audiences: ["SPONSOR"] as const }];
    expect(effectiveRoutes(saved.map((r) => ({ ...r, audiences: [...r.audiences] })), ["ATTENDEE"])).toEqual([{ key: "a", label: "A", audiences: ["ATTENDEE"] }]);
  });

  it("a question shared by several surveys is asked once, in the option's survey order", () => {
    const sections = [
      { audience: "ATTENDEE", questions: [{ key: "q_is_local" }, { key: "q_spend" }] },
      { audience: "RESIDENT", questions: [{ key: "q_is_local" }, { key: "q_noise" }] },
    ];
    expect(combinedQuestions(sections, ["ATTENDEE", "RESIDENT"]).map((q) => q.key)).toEqual(["q_is_local", "q_spend", "q_noise"]);
    expect(combinedQuestions(sections, ["RESIDENT", "ATTENDEE"]).map((q) => q.key)).toEqual(["q_is_local", "q_noise", "q_spend"]);
  });

  it("validates options", () => {
    expect(routesSchema.safeParse([{ key: "a", label: "A", audiences: ["ATTENDEE"] }, { key: "a", label: "B", audiences: ["SPONSOR"] }]).success).toBe(false);
    expect(routesSchema.safeParse([{ key: "a", label: "A", audiences: ["ATTENDEE", "ATTENDEE"] }]).success).toBe(false);
    expect(routesSchema.safeParse([{ key: "A b", label: "A", audiences: ["ATTENDEE"] }]).success).toBe(false);
    expect(routesSchema.safeParse([]).success).toBe(false);
  });
});
