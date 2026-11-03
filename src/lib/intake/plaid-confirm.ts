import { AppError, logInfo, userMessageFor } from "../telemetry";
import { INCOME_STAGE_QUESTION_IDS } from "./income";
import { saveAnswer, validateAnswerInput } from "./store";

// The Plaid Sandbox confirm flow (HACK-140), the bank card's one writer.
//
// The broker persists nothing: the decrypted payload lives in page memory
// and the proposals are recomputed locally until the person decides. This
// module is the server half of that decision, mirroring the tax-return
// confirm flow:
//
// - action "confirm"  — the person accepts a bank proposal as-is; the
//   answer saves with provenance `user` (the person vouched for the value).
//   Admitted ONLY for the ids the bank card actually proposes
//   (plaid-proposal.ts: job/benefits/other amounts and their frequencies).
// - action "correct"  — the person typed their own value, also `user`.
//
// The bank's institution name is NOT written here: it is pii:true metadata
// captured from Plaid Link and sealed by the browser in the client-side
// encrypted store (HACK-140), so it never reaches this route or Postgres.
//
// Both save with status `known` and only ever target the seven income spec
// questions, which stay `pii:false` in the plain answer table. Re-saving a
// question overwrites its one row (update-not-duplicate).

/** The ids the bank card proposes from Bank Income streams (browser-safe). */
export const PLAID_PROPOSED_QUESTION_IDS = [
  "job_income_amount",
  "job_income_frequency",
  "benefits_income_amount",
  "benefits_income_frequency",
  "other_income_amount",
] as const;

/** The income set is 7; anything beyond this bound is a junk request. */
export const MAX_PLAID_CONFIRMATIONS_PER_CALL = 32;

export type PlaidConfirmationAction = "confirm" | "correct";

export interface PlaidConfirmation {
  readonly questionId: string;
  readonly action: PlaidConfirmationAction;
  readonly value: unknown;
}

export interface SavedPlaidAnswer {
  readonly questionId: string;
  readonly provenance: "user";
}

function validationError(): AppError {
  return new AppError("validation_error", userMessageFor("validation_error"));
}

/**
 * Validate the whole batch WITHOUT touching the database: every entry must
 * target an income question, carry a known action, and hold a spec-valid
 * value for status `known`. A confirmed value claims a bank origin, so it
 * is admitted only for the bank card's real proposal ids; everything else
 * must travel as a person-corrected value. A bad entry anywhere rejects
 * the batch and saves nothing.
 */
export function parsePlaidConfirmations(input: unknown): PlaidConfirmation[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_PLAID_CONFIRMATIONS_PER_CALL
  ) {
    throw validationError();
  }
  const incomeIds: readonly string[] = INCOME_STAGE_QUESTION_IDS;
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
    if (
      action === "confirm" &&
      !(PLAID_PROPOSED_QUESTION_IDS as readonly string[]).includes(questionId)
    ) {
      throw validationError();
    }
    validateAnswerInput(questionId, "known", value);
    return { questionId, action, value };
  });
}

/**
 * Persist the person's confirmed/corrected bank-derived income answers
 * through the standard answer store. Returns ids and provenances only —
 * the values live in the returned client state, the person's answers.
 */
export async function saveConfirmedPlaidAnswers(
  sessionId: string,
  confirmations: readonly PlaidConfirmation[],
): Promise<SavedPlaidAnswer[]> {
  const saved: SavedPlaidAnswer[] = [];
  for (const { questionId, value } of confirmations) {
    const provenance: SavedPlaidAnswer["provenance"] = "user";
    await saveAnswer(sessionId, questionId, "known", value, provenance);
    saved.push({ questionId, provenance });
  }
  logInfo("plaid_confirmations_saved", { count: saved.length });
  return saved;
}
