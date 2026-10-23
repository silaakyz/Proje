import { describe, expect, it } from "vitest";
import { AnswerValidationError, normaliseAnswers, type StoredQuestion } from "@/lib/surveys/answers";

const q = (questionKey: string, type: string, extra: Partial<StoredQuestion> = {}): StoredQuestion => ({
  questionKey, type, isMandatory: false, isSensitive: false, options: null, metadata: {}, ...extra,
});
const QS: StoredQuestion[] = [
  q("q_is_local", "YES_NO", { isMandatory: true }),
  q("q_party_size", "NUMBER", { isMandatory: true, metadata: { showIf: { key: "q_is_local", equals: false } } }),
  q("q_spend_food", "CURRENCY_TRY", { metadata: { spendCategory: "FOOD_BEVERAGE", showIf: { key: "q_is_local", equals: false } } }),
  q("x_food_extra", "CURRENCY_TRY", { metadata: { spendCategory: "FOOD_BEVERAGE", showIf: { key: "q_is_local", equals: false } } }),
  q("x_topics", "MULTI_CHOICE", { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }),
  q("q_main_reason", "SINGLE_CHOICE", { options: [{ value: "event", label: "E" }, { value: "other", label: "O" }] }),
];
const problems = (raw: Record<string, unknown>) => {
  try {
    normaliseAnswers(QS, raw, { sensitiveConsent: false });
    return [];
  } catch (e) {
    return (e as AnswerValidationError).problems;
  }
};

describe("survey answer normalisation", () => {
  it("adds spend of one category in kuruş and fills the profile", () => {
    const n = normaliseAnswers(QS, { q_is_local: false, q_party_size: 3, q_spend_food: 120.25, x_food_extra: 10, q_main_reason: "event" }, { sensitiveConsent: false });
    expect(n).toMatchObject({ isLocalResident: false, partySize: 3, mainReason: "event", spendKurus: { FOOD_BEVERAGE: 13_025 } });
  });
  it("treats empty values as unanswered", () => {
    expect(normaliseAnswers(QS, { q_is_local: true, x_topics: null, q_main_reason: "" }, { sensitiveConsent: false }).answers).toEqual({ q_is_local: true });
  });
  it("rejects wrong types, fractions of a kuruş, bad choices, duplicates and hidden questions", () => {
    expect(problems({ q_is_local: "no" })).toEqual(["q_is_local: must be true or false", "q_is_local: required"]);
    expect(problems({ q_is_local: false, q_party_size: 2.5 })).toEqual(["q_party_size: must be an integer 1–500", "q_party_size: required"]);
    expect(problems({ q_is_local: false, q_party_size: 2, q_spend_food: 1.005 })).toEqual(["q_spend_food: must be an amount in TL (≥ 0, max 2 decimals)"]);
    expect(problems({ q_is_local: true, x_topics: ["a", "a"] })).toEqual(["x_topics: must be a non-empty list of distinct options"]);
    expect(problems({ q_is_local: true, q_main_reason: "x" })).toEqual(["q_main_reason: must be one of the options"]);
    expect(problems({ q_is_local: true, q_spend_food: 5 })).toEqual(["q_spend_food: not asked for the given answers (showIf)"]);
  });
});
