import { AppError, logInfo, userMessageFor } from "../telemetry";
import { saveAnswer, validateAnswerInput } from "./store";

// The tax-return confirm flow (milestone income-capture part 2; VAL-INC-007).
//
// The upload route (src/app/api/intake/tax-return) returns typed findings
// and persists NOTHING — the document is never stored, so the proposals
// live only in the person's browser until they decide. This module is the
// one writer of tax-return-derived answers: the confirm call carries the
// person's per-question decision and the value they are vouching for.
//
// Per-entry semantics:
// - action "confirm"  — the person accepts the parsed proposal as-is;
//   the answer saves with provenance `tax_return` (origin badge "From
//   your tax return").
// - action "correct"  — the person replaced the proposal with their own
//   value; the answer saves with provenance `user`.
//
// Both save with status `known` (the person just vouched for the value)
// and only ever target the income spec questions, which stay `pii:false`
// in the plain answer table — NO storage-semantics change in this
// milestone. Re-confirming a question overwrites its one row (the store's
// UNIQUE(session_id, question_id) upsert): update-not-duplicate, so a
// re-upload followed by a new confirm replaces the prior values.

/** The income spec questions the confirm flow may write (all pii:false). */
export const TAX_RETURN_ANSWER_QUESTION_IDS = [
  "income_sources",
  "income_kind",
  "job_income_amount",
  "job_income_frequency",
  "benefits_income_amount",
  "benefits_income_frequency",
  "other_income_amount",
] as const;

/** The income set is 7; anything beyond this bound is a junk request. */
export const MAX_CONFIRMATIONS_PER_CALL = 32;

export type TaxReturnConfirmationAction = "confirm" | "correct";

export interface TaxReturnConfirmation {
  readonly questionId: string;
  readonly action: TaxReturnConfirmationAction;
  readonly value: unknown;
}

export interface SavedTaxAnswer {
  readonly questionId: string;
  readonly provenance: "tax_return" | "user";
}

function validationError(): AppError {
  return new AppError("validation_error", userMessageFor("validation_error"));
}

/**
 * Validate the confirm body against the income question set WITHOUT
 * touching the database: every entry must target an income question,
 * carry a known action, and hold a spec-valid value for status `known`.
 * Validating the WHOLE batch first means a bad entry anywhere saves
 * nothing (a rejected first confirm never leaves an orphan row behind).
 */
export function parseTaxReturnConfirmations(
  input: unknown,
): TaxReturnConfirmation[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_CONFIRMATIONS_PER_CALL
  ) {
    throw validationError();
  }
  const incomeIds: readonly string[] = TAX_RETURN_ANSWER_QUESTION_IDS;
  return input.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw validationError();
    }
    const { questionId, action, value } = entry as Record<string, unknown>;
    if (typeof questionId !== "string" || !incomeIds.includes(questionId)) {
      throw validationError();
    }
    if (action !== "confirm" && action !== "correct") {
      throw validationError();
    }
    // Spec validation (question id shape + value canonicalizes under
    // status known) — throws the taxonomy validation_error on any
    // mismatch. saveAnswer re-validates when it writes.
    validateAnswerInput(questionId, "known", value);
    return { questionId, action, value };
  });
}

/**
 * Persist the person's confirmed/corrected income answers through the
 * standard answer store. Each save is the store's ordinary upsert: one
 * row per question, updated in place on re-confirm. Returns the saved
 * ids and provenances only — the values never echo back here (they are
 * in the returned client state, the person's confirmed answers).
 */
export async function saveConfirmedTaxAnswers(
  sessionId: string,
  confirmations: readonly TaxReturnConfirmation[],
): Promise<SavedTaxAnswer[]> {
  const saved: SavedTaxAnswer[] = [];
  for (const { questionId, action, value } of confirmations) {
    const provenance: SavedTaxAnswer["provenance"] =
      action === "confirm" ? "tax_return" : "user";
    await saveAnswer(sessionId, questionId, "known", value, provenance);
    saved.push({ questionId, provenance });
  }
  logInfo("tax_return_confirmations_saved", { count: saved.length });
  return saved;
}
