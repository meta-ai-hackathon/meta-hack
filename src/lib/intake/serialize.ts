import { AppError } from "../telemetry";
import type { IntakeClientState } from "./client-state";
import { QUESTIONS } from "./spec";

// Client-state serialization boundary (BN-09): the ONLY shape the intake API
// returns to a browser. Enforced here, at serialization: a pii:true answer
// contributes its tri-state status alone — its value is structurally omitted,
// so no pii value can reach the page source or any client payload
// (VAL-INTAKE-004). Skipped questions and their stored answers are omitted
// entirely: a skipped question never renders anywhere in the flow.
//
// The state's shape and its pure builder live in client-state.ts, which the
// on-device intake (HACK-99) also uses in the browser; this module adds the
// server-side defense in depth below.

export {
  buildClientState,
  type ClientAnswer,
  type ClientQuestion,
  type IntakeClientState,
  type IntakeProgress,
} from "./client-state";

/**
 * Defense in depth for the serialization boundary: throw loudly if a state
 * about to be sent to a client carries a value under a pii:true question.
 * The message stays generic; no value or question id is echoed back.
 */
export function assertNoPiiValues(state: IntakeClientState): void {
  const piiIds = new Set(
    QUESTIONS.filter((question) => question.pii).map((question) => question.id),
  );
  for (const [questionId, answer] of Object.entries(state.answers)) {
    if (piiIds.has(questionId) && answer && "value" in answer) {
      throw new AppError(
        "internal",
        "A client payload attempted to include a private answer value.",
      );
    }
  }
}
