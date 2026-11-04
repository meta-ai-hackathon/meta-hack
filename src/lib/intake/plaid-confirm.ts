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
// - action "confirm"  — the person accepts a bank proposal as-is. An
//   untouched AMOUNT saves with status `unverified`, never `known`: every
//   figure is Sandbox test-bank data, and a salary proposal is a NET
//   deposit average while NC Medicaid counts GROSS pay. Keeping it
//   unverified means the number is never presented as a confirmed fact on
//   the form; the bank card asks the person to enter their own gross figure
//   to confirm it. A FREQUENCY confirm saves `known` with provenance `user`
//   (Plaid's categorical schedule carries no amount, and the person vouched
//   for the schedule).
// - action "correct"  — the person typed their own value, saved `known`
//   with provenance `user`.
//
// The bank's institution name is NOT written here: it is pii:true metadata
// captured from Plaid Link and sealed by the browser in the client-side
// encrypted store (HACK-140), so it never reaches this route or Postgres.
//
// Every write targets only the seven income spec questions, which stay
// `pii:false` in the plain answer table. Re-saving a question overwrites
// its one row (update-not-duplicate).

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
  readonly status: AnswerStatus;
  readonly provenance: AnswerProvenance;
}

function validationError(): AppError {
  return new AppError("validation_error", userMessageFor("validation_error"));
}

/**
 * The status/provenance each decision saves with. An untouched amount is
 * unverified (Sandbox test data, and salary is net of withholding); a
 * corrected value is the person's own and saves as known/user. A confirmed
 * frequency is known/user because it carries no amount.
 */
export function plaidSaveFor(
  action: PlaidConfirmationAction,
  questionId: string,
): { readonly status: AnswerStatus; readonly provenance: AnswerProvenance } {
  if (action === "correct") {
    return { status: "known", provenance: "user" };
  }
  return questionId.endsWith("_amount")
    ? { status: "unverified", provenance: "user_supplied" }
    : { status: "known", provenance: "user" };
}

/**
 * Validate the whole batch WITHOUT touching the database: every entry must
 * target an income question, carry a known action, and hold a spec-valid
 * value. A confirmed value claims a bank origin, so it is admitted only for
 * the bank card's real proposal ids; everything else must travel as a
 * person-corrected value. A bad entry anywhere rejects the batch and saves
 * nothing.
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
    // known and unverified canonicalize identically; the mapping to the
    // stored status happens in saveConfirmedPlaidAnswers.
    validateAnswerInput(questionId, "known", value);
    return { questionId, action, value };
  });
}

/**
 * Persist the person's confirmed/corrected bank-derived income answers
 * through the standard answer store. Returns ids, statuses and provenances
 * only — the values live in the returned client state, the person's answers.
 */
export async function saveConfirmedPlaidAnswers(
  sessionId: string,
  confirmations: readonly PlaidConfirmation[],
): Promise<SavedPlaidAnswer[]> {
  const saved: SavedPlaidAnswer[] = [];
  for (const { questionId, action, value } of confirmations) {
    const { status, provenance } = plaidSaveFor(action, questionId);
    await saveAnswer(sessionId, questionId, status, value, provenance);
    saved.push({ questionId, status, provenance });
  }
  logInfo("plaid_confirmations_saved", { count: saved.length });
  return saved;
}
