import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalAnswerValue, MAX_ANSWER_TEXT_LENGTH } from "./answer-input";
import { QUESTIONS, type Question } from "./spec";
import { validateAnswerInput } from "./store";

// Answer-value canonicalization (HACK-99 moved it out of the server store
// so the on-device intake checks answers exactly as the server does). The
// properties: the server's validation and the shared function agree on
// every input, canonical values are stable, and each type's rules hold.

const draftArb = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.constantFrom("", "   ", " 42 ", "4e2", "NaN", "Infinity", "1990-04-02", "1990-4-2"),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.string({ maxLength: 10 }), { maxLength: 4 }),
  fc.constantFrom(...QUESTIONS.flatMap((question) => question.options?.map((option) => option.value) ?? [])),
  fc
    .constantFrom(...QUESTIONS.filter((question) => question.type === "multi_select"))
    .chain((question) => fc.subarray(question.options!.map((option) => option.value))),
);

describe("canonicalAnswerValue", () => {
  it("agrees with the server's validation on every input", () => {
    fc.assert(
      fc.property(fc.constantFrom(...QUESTIONS), draftArb, (question, draft) => {
        const canonical = canonicalAnswerValue(question, draft);
        if (canonical === null) {
          expect(() => validateAnswerInput(question.id, "known", draft)).toThrow();
        } else {
          expect(validateAnswerInput(question.id, "known", draft).storedValue).toEqual(canonical);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("is stable: a canonical value canonicalizes to itself", () => {
    fc.assert(
      fc.property(fc.constantFrom(...QUESTIONS), draftArb, (question, draft) => {
        const canonical = canonicalAnswerValue(question, draft);
        if (canonical !== null) {
          expect(canonicalAnswerValue(question, canonical)).toEqual(canonical);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("holds each type's rules", () => {
    const byType = (type: Question["type"]) =>
      QUESTIONS.find((question) => question.type === type)!;
    const text = byType("text");
    expect(canonicalAnswerValue(text, "  hi  ")).toBe("hi");
    expect(canonicalAnswerValue(text, "   ")).toBeNull();
    expect(canonicalAnswerValue(text, "x".repeat(MAX_ANSWER_TEXT_LENGTH))).toHaveLength(
      MAX_ANSWER_TEXT_LENGTH,
    );
    expect(canonicalAnswerValue(text, "x".repeat(MAX_ANSWER_TEXT_LENGTH + 1))).toBeNull();
    expect(canonicalAnswerValue(text, 5)).toBeNull();

    const number = byType("number");
    expect(canonicalAnswerValue(number, "3")).toBe(3);
    expect(canonicalAnswerValue(number, 2.5)).toBe(2.5);
    expect(canonicalAnswerValue(number, "")).toBeNull();
    expect(canonicalAnswerValue(number, "Infinity")).toBeNull();
    expect(canonicalAnswerValue(number, Number.NaN)).toBeNull();

    const date = byType("date");
    expect(canonicalAnswerValue(date, "1990-04-02")).toBe("1990-04-02");
    expect(canonicalAnswerValue(date, "1990-4-2")).toBeNull();

    const single = byType("single_select");
    expect(canonicalAnswerValue(single, single.options![0].value)).toBe(single.options![0].value);
    expect(canonicalAnswerValue(single, "not-an-option")).toBeNull();

    const multi = byType("multi_select");
    const [a, b] = multi.options!.map((option) => option.value);
    expect(canonicalAnswerValue(multi, [a, b, a])).toEqual([a, b]);
    expect(canonicalAnswerValue(multi, [])).toBeNull();
    expect(canonicalAnswerValue(multi, [a, "not-an-option"])).toBeNull();

    const boolean = byType("boolean");
    expect(canonicalAnswerValue(boolean, false)).toBe(false);
    expect(canonicalAnswerValue(boolean, "false")).toBeNull();
  });
});
