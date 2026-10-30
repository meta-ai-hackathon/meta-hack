// Shown post-submission purge (HACK-80): after a fax is confirmed, the
// app visibly removes the user's information from the device — and the
// purge is a UI beat, not just a behavior, so the demo recording shows
// real app use doing it.
//
// This module owns the purge SEQUENCE as pure, testable logic. The
// storage effects themselves (sealed client-store removal, consent
// receipt clearing) are injected as `PurgeEffects`, so:
// - the ordering and honesty rules are proven here without a browser;
// - the wiring PR connects the real effects (the client store from
//   HACK-94/PR #52) without changing this contract.
//
// Honesty rules the sequence enforces:
// - Purge runs ONLY on a confirmed transmission (or an explicit manual
//   "delete my answers" — same wipe, different trigger). A failed fax
//   purges nothing: `planPurge` refuses without a confirmation, so no
//   caller can wipe answers on an unconfirmed send.
// - Every step is verified: after each removal, the effect re-reads and
//   reports whether the data is actually gone. A step that cannot be
//   verified does NOT report success — the final screen says exactly
//   what remains, including failures (clearing site data is the stated
//   fallback), never a clean story the device cannot back up.
// - The fax confirmation is the sole survivor: it contains no form data
//   (confirmation id, destination, page count, timestamp), and it is
//   named on the final screen as the one thing kept.
// - Nothing here submits, signs, or changes a lifecycle state (BN-25):
//   purging is deletion, not submission. The user reported the
//   submission; the app only cleans up after it.

/** Why a purge is running. Both triggers run the identical wipe. */
export type PurgeTrigger =
  | { readonly kind: "fax_confirmed"; readonly confirmationId: string }
  | { readonly kind: "manual" };

export interface PurgeStepResult {
  readonly step: PurgeStepId;
  /** True only when the removal was re-read and verified empty. */
  readonly removed: boolean;
}

export type PurgeStepId = "answers" | "consent_receipt";

export interface PurgeEffects {
  /** Remove stored answers; true only when verified gone afterwards. */
  removeAnswers(): Promise<boolean>;
  /** Remove the consent receipt; true only when verified gone after. */
  removeConsentReceipt(): Promise<boolean>;
}

export interface PurgePlan {
  readonly trigger: PurgeTrigger;
  readonly steps: readonly PurgeStepId[];
}

export type PurgePlanResult =
  | { readonly ok: true; readonly plan: PurgePlan }
  | { readonly ok: false; readonly reason: "missing_confirmation" };

/**
 * Gate the purge on its trigger. A fax-triggered purge without a
 * confirmation id is refused outright — answers are never wiped on an
 * unconfirmed send. Manual purges are the user's own delete control and
 * need no confirmation.
 */
export function planPurge(trigger: PurgeTrigger): PurgePlanResult {
  if (
    trigger.kind === "fax_confirmed" &&
    (typeof trigger.confirmationId !== "string" ||
      trigger.confirmationId.trim() === "")
  ) {
    return { ok: false, reason: "missing_confirmation" };
  }
  return {
    ok: true,
    plan: { trigger, steps: ["answers", "consent_receipt"] },
  };
}

/** The on-screen sequence, in order. Copy is banned-claim-clean (tested). */
export const PURGE_SCREEN_LINES = {
  working: "Removing your answers from this device…",
  keptHeading: "What we kept",
  removedHeading: "What is gone",
  answersGone: "Every answer you gave, on this device",
  answersRemain:
    "Your answers could not be removed automatically. Clear this site's data in your browser to remove them.",
  receiptGone: "Your sharing choices record",
  receiptRemain:
    "Your sharing choices record could not be removed automatically. Clear this site's data in your browser to remove it.",
  confirmationKept:
    "The fax confirmation — its number, the fax number it went to, how many pages, and when. It holds none of your answers.",
} as const;

export interface PurgeOutcome {
  readonly trigger: PurgeTrigger;
  readonly results: readonly PurgeStepResult[];
  /** True only when EVERY step verified removal. */
  readonly fullyRemoved: boolean;
  /** Screen lines for the end state, derived from the verified results. */
  readonly keptLines: readonly string[];
  readonly removedLines: readonly string[];
  readonly remainingLines: readonly string[];
}

/**
 * Run the planned purge: each effect in order, then an honest outcome.
 * The outcome's screen copy is computed from the VERIFIED results, so
 * the confirmation screen can never claim a removal that did not hold.
 */
export async function executePurge(
  plan: PurgePlan,
  effects: PurgeEffects,
): Promise<PurgeOutcome> {
  const results: PurgeStepResult[] = [];
  for (const step of plan.steps) {
    const removed =
      step === "answers"
        ? await effects.removeAnswers()
        : await effects.removeConsentReceipt();
    results.push({ step, removed });
  }

  const removedLines: string[] = [];
  const remainingLines: string[] = [];
  for (const result of results) {
    if (result.step === "answers") {
      (result.removed ? removedLines : remainingLines).push(
        result.removed
          ? PURGE_SCREEN_LINES.answersGone
          : PURGE_SCREEN_LINES.answersRemain,
      );
    } else {
      (result.removed ? removedLines : remainingLines).push(
        result.removed
          ? PURGE_SCREEN_LINES.receiptGone
          : PURGE_SCREEN_LINES.receiptRemain,
      );
    }
  }

  return {
    trigger: plan.trigger,
    results,
    fullyRemoved: results.every((result) => result.removed),
    keptLines:
      plan.trigger.kind === "fax_confirmed"
        ? [PURGE_SCREEN_LINES.confirmationKept]
        : [],
    removedLines,
    remainingLines,
  };
}
