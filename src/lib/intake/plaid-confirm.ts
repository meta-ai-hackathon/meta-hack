import { type AnswerProvenance, type AnswerStatus } from "../honesty";
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
// - action "confirm"  — rejected: an untouched proposal is Sandbox test-bank
//   data, and income-verification data must stay on the device. The client
//   never sends one; saving it would put a synthetic figure or schedule into
//   a real person's application answers.
// - action "correct"  — the person typed or chose their own value, saved
//   `known` with provenance `user`. The server cannot tell a real edit from a
//   re-submitted proposal: it accepts any spec-valid corrected value, so the
//   "untouched is never stored" guarantee is a client-flow property, not a
//   server-verifiable one.
//
// The bank's institution name is NOT written here: it is pii:true metadata
// captured from Plaid Link and shown only in page memory (HACK-140), so it
// never reaches this route or Postgres.
//
// Every write targets only the seven income spec questions, which stay
// `pii:false` in the plain answer table. Re-saving a question overwrites
// its one row (update-not-duplicate).

/** The income set is 7; anything beyond this bound is a junk request. */
export const MAX_PLAID_CONFIRMATIONS_PER_CALL = 32;

export type PlaidConfirmationAction = "correct";

export interface PlaidConfirmation {
  readonly questionId: string;
  readonly action: PlaidConfirmationAction;
  readonly value: unknown;
}

export interface SavedPlaidAnswer {
  readonly questionId: string;
  readonly status: AnswerStatus;
  readonly provenance: AnswerProvenance;
}

function validationError(): AppError {
  return new AppError("validation_error", userMessageFor("validation_error"));
}

/**
 * Validate the whole batch WITHOUT touching the database: every entry must
 * target an income question, carry the `correct` action, and hold a
 * spec-valid value. The client sends only person-edited values; the server
 * cannot verify that distinction, so it enforces the action and question
 * bound but accepts any spec-valid corrected value. A bad entry anywhere
 * rejects the batch and saves nothing.
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
    if (action !== "correct") {
      throw validationError();
    }
    // known and unverified canonicalize identically; the mapping to the
    // stored status happens in saveConfirmedPlaidAnswers.
    validateAnswerInput(questionId, "known", value);
    return { questionId, action, value };
  });
}

/**
 * Persist the person's own (corrected) bank-income values through the
 * standard answer store. The client flow only sends person-edited values;
 * this function accepts any spec-valid value it is given. Returns
 * ids, statuses and provenances only — the values live in the returned
 * client state, the person's answers.
 */
export async function saveConfirmedPlaidAnswers(
  sessionId: string,
  confirmations: readonly PlaidConfirmation[],
): Promise<SavedPlaidAnswer[]> {
  const saved: SavedPlaidAnswer[] = [];
  for (const { questionId, value } of confirmations) {
    await saveAnswer(sessionId, questionId, "known", value, "user");
    saved.push({ questionId, status: "known", provenance: "user" });
  }
  logInfo("plaid_confirmations_saved", { count: saved.length });
  return saved;
}
