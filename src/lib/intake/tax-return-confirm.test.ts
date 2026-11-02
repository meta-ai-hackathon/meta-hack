import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AppError } from "../telemetry";
import { QUESTIONS } from "./spec";
import {
  MAX_CONFIRMATIONS_PER_CALL,
  parseTaxReturnConfirmations,
  TAX_RETURN_ANSWER_QUESTION_IDS,
} from "./tax-return-confirm";
import { TAX_RETURN_PROPOSED_QUESTION_IDS } from "../income/tax-proposal";

// Unit tests for the tax-return confirm-flow validation (VAL-INC-007): the
// confirm body is bounded, targets ONLY the income spec questions (so the
// confirm route can never become a general-purpose provenance writer, and a
// pii:true question can never cross it), and every value is validated
// against the question spec before anything is saved.

function validationErrorOf(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a taxonomy validation_error");
}

/** A value the question spec accepts under status `known`. */
function specValidValueFor(questionId: string): unknown {
  const question = QUESTIONS.find((entry) => entry.id === questionId);
  if (question === undefined) {
    throw new Error(`unknown question ${questionId}`);
  }
  if (question.type === "multi_select") {
    return [question.options?.[0]?.value ?? "x"];
  }
  if (question.type === "number") {
    return 1;
  }
  return question.options?.[0]?.value ?? "x";
}

describe("tax-return confirmations (VAL-INC-007)", () => {
  it("targets only income spec questions, and every one is pii:false", () => {
    for (const questionId of TAX_RETURN_ANSWER_QUESTION_IDS) {
      const question = QUESTIONS.find((entry) => entry.id === questionId);
      expect(question, questionId).toBeDefined();
      expect(question?.pii, questionId).toBe(false);
    }
  });

  it("accepts confirm and correct entries with spec-valid values", () => {
    const parsed = parseTaxReturnConfirmations([
      { questionId: "job_income_amount", action: "confirm", value: 52500 },
      {
        questionId: "job_income_frequency",
        action: "correct",
        value: "monthly",
      },
    ]);
    expect(parsed).toEqual([
      { questionId: "job_income_amount", action: "confirm", value: 52500 },
      {
        questionId: "job_income_frequency",
        action: "correct",
        value: "monthly",
      },
    ]);
  });

  it("admits action:'confirm' only for the stage UI's proposal ids (milestone part 3 tightening)", () => {
    // tax_return provenance is client-asserted by design; the route bounds
    // it to the ids the stage UI actually proposes from parser findings
    // (the prior-year monthly figure + its frequency). Every OTHER income
    // id must travel as a correction (provenance user), even with a
    // perfectly valid value.
    for (const questionId of TAX_RETURN_ANSWER_QUESTION_IDS) {
      const value = specValidValueFor(questionId);
      if (
        (TAX_RETURN_PROPOSED_QUESTION_IDS as readonly string[]).includes(
          questionId,
        )
      ) {
        expect(
          parseTaxReturnConfirmations([
            { questionId, action: "confirm", value },
          ]),
        ).toHaveLength(1);
      } else {
        expect(() =>
          parseTaxReturnConfirmations([
            { questionId, action: "confirm", value },
          ]),
        ).toThrow(AppError);
        // ...while the same id as a person-corrected value is fine.
        expect(
          parseTaxReturnConfirmations([
            { questionId, action: "correct", value },
          ]),
        ).toHaveLength(1);
      }
    }
  });

  it("rejects a non-income question id", () => {
    const error = validationErrorOf(() =>
      parseTaxReturnConfirmations([
        { questionId: "main_goal", action: "confirm", value: "food" },
      ]),
    );
    expect(error.code).toBe("validation_error");
  });

  it("rejects a pii:true question id — the boundary bites here too", () => {
    const error = validationErrorOf(() =>
      parseTaxReturnConfirmations([
        { questionId: "disability_status", action: "confirm", value: true },
      ]),
    );
    expect(error.code).toBe("validation_error");
  });

  it("rejects unknown actions", () => {
    validationErrorOf(() =>
      parseTaxReturnConfirmations([
        { questionId: "job_income_amount", action: "guess", value: 1 },
      ]),
    );
  });

  it("rejects spec-invalid values", () => {
    validationErrorOf(() =>
      parseTaxReturnConfirmations([
        {
          questionId: "job_income_amount",
          action: "confirm",
          value: Number.NaN,
        },
      ]),
    );
    validationErrorOf(() =>
      parseTaxReturnConfirmations([
        {
          questionId: "job_income_frequency",
          action: "confirm",
          value: "martian",
        },
      ]),
    );
    validationErrorOf(() =>
      parseTaxReturnConfirmations([
        {
          questionId: "income_sources",
          action: "confirm",
          value: ["martian"],
        },
      ]),
    );
  });

  it("rejects an empty, non-array, or oversized body", () => {
    validationErrorOf(() => parseTaxReturnConfirmations([]));
    validationErrorOf(() => parseTaxReturnConfirmations("confirmations"));
    validationErrorOf(() =>
      parseTaxReturnConfirmations(
        Array.from({ length: MAX_CONFIRMATIONS_PER_CALL + 1 }, () => ({
          questionId: "job_income_amount",
          action: "confirm",
          value: 1,
        })),
      ),
    );
  });

  it("rejects entries that are not objects", () => {
    validationErrorOf(() =>
      parseTaxReturnConfirmations(["job_income_amount"]),
    );
  });

  // Property (the confirm boundary bites over the WHOLE id universe): for
  // every spec question outside the income set — pii:true ones included —
  // a confirm entry targeting it is refused, whatever the action. The
  // confirm path can never become a general-purpose answer writer.
  it("rejects every spec question outside the income set (property)", () => {
    const otherIds = QUESTIONS.filter(
      (question) =>
        !(TAX_RETURN_ANSWER_QUESTION_IDS as readonly string[]).includes(
          question.id,
        ),
    ).map((question) => question.id);
    expect(otherIds.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(
        fc.constantFrom(...otherIds),
        fc.constantFrom("confirm", "correct"),
        (questionId, action) => {
          try {
            parseTaxReturnConfirmations([{ questionId, action, value: 1 }]);
            return false;
          } catch {
            return true;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property (closed failure mode): any arbitrary JSON body either parses
  // to a bounded entry list or throws the taxonomy validation_error —
  // never any other error shape, never an unbounded parse.
  it("any arbitrary input parses bounded or throws validation_error (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 40 }), (junk) => {
        try {
          const parsed = parseTaxReturnConfirmations(junk);
          return (
            Array.isArray(parsed) && parsed.length <= MAX_CONFIRMATIONS_PER_CALL
          );
        } catch (error) {
          return error instanceof AppError && error.code === "validation_error";
        }
      }),
      { numRuns: 100 },
    );
  });
});
