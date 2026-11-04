import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AppError } from "../telemetry";
import { QUESTIONS } from "./spec";
import {
  MAX_PLAID_CONFIRMATIONS_PER_CALL,
  parsePlaidConfirmations,
} from "./plaid-confirm";
import { INCOME_STAGE_QUESTION_IDS } from "./income";

// Unit tests for the Plaid confirm-flow validation (HACK-140): the confirm
// body is bounded, targets ONLY the seven income spec questions (so the
// route can never become a general-purpose provenance writer and a
// pii:true question can never cross it), every untouched `confirm` entry is
// rejected so bank data stays on the device, and every corrected value is
// validated against the question spec before anything saves.

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

describe("plaid confirmations (HACK-140)", () => {
  it("targets only income spec questions, and every one is pii:false", () => {
    for (const questionId of INCOME_STAGE_QUESTION_IDS) {
      const question = QUESTIONS.find((entry) => entry.id === questionId);
      expect(question, questionId).toBeDefined();
      expect(question?.pii, questionId).toBe(false);
    }
  });

  it("accepts only corrected entries with spec-valid values", () => {
    expect(
      parsePlaidConfirmations([
        {
          questionId: "job_income_frequency",
          action: "correct",
          value: "weekly",
        },
      ]),
    ).toEqual([
      {
        questionId: "job_income_frequency",
        action: "correct",
        value: "weekly",
      },
    ]);
    expect(() =>
      parsePlaidConfirmations([
        { questionId: "job_income_amount", action: "confirm", value: 2100 },
      ]),
    ).toThrow(AppError);
  });

  it("rejects every untouched confirm entry and accepts a correction", () => {
    for (const questionId of INCOME_STAGE_QUESTION_IDS) {
      const value = specValidValueFor(questionId);
      expect(() =>
        parsePlaidConfirmations([{ questionId, action: "confirm", value }]),
      ).toThrow(AppError);
      expect(
        parsePlaidConfirmations([{ questionId, action: "correct", value }]),
      ).toHaveLength(1);
    }
  });

  it("rejects a non-income, pii:true, or unknown-action entry", () => {
    validationErrorOf(() =>
      parsePlaidConfirmations([
        { questionId: "main_goal", action: "confirm", value: "food" },
      ]),
    );
    validationErrorOf(() =>
      parsePlaidConfirmations([
        { questionId: "disability_status", action: "confirm", value: true },
      ]),
    );
    validationErrorOf(() =>
      parsePlaidConfirmations([
        { questionId: "job_income_amount", action: "guess", value: 1 },
      ]),
    );
  });

  it("rejects spec-invalid values and unbounded bodies", () => {
    validationErrorOf(() =>
      parsePlaidConfirmations([
        { questionId: "job_income_amount", action: "confirm", value: Number.NaN },
      ]),
    );
    validationErrorOf(() => parsePlaidConfirmations([]));
    validationErrorOf(() => parsePlaidConfirmations("confirmations"));
    validationErrorOf(() =>
      parsePlaidConfirmations(
        Array.from({ length: MAX_PLAID_CONFIRMATIONS_PER_CALL + 1 }, () => ({
          questionId: "job_income_amount",
          action: "confirm",
          value: 1,
        })),
      ),
    );
    validationErrorOf(() => parsePlaidConfirmations(["job_income_amount"]));
  });

  // Property (the boundary bites over the WHOLE id universe): every spec
  // question outside the income set — pii:true ones included — is refused,
  // whatever the action.
  it("rejects every spec question outside the income set (property)", () => {
    const otherIds = QUESTIONS.filter(
      (question) =>
        !(INCOME_STAGE_QUESTION_IDS as readonly string[]).includes(
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
            parsePlaidConfirmations([{ questionId, action, value: 1 }]);
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
  // to a bounded entry list or throws the taxonomy validation_error.
  it("any arbitrary input parses bounded or throws validation_error (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 40 }), (junk) => {
        try {
          const parsed = parsePlaidConfirmations(junk);
          return (
            Array.isArray(parsed) &&
            parsed.length <= MAX_PLAID_CONFIRMATIONS_PER_CALL
          );
        } catch (error) {
          return error instanceof AppError && error.code === "validation_error";
        }
      }),
      { numRuns: 100 },
    );
  });
});
