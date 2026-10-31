import type { SessionStatus } from "./honesty";
import {
  KB_ENTRIES,
  citeSourcedSteps,
  type KbEntry,
  type KbSourceCardView,
  type KbSourcedStepGroup,
  type KbStepCitation,
  type SourcedStepKbFactGroupName,
} from "./kb";

// The handoff's one next action (BN-23, HACK-49) and its sourced
// companion steps (BN-24 and BN-26, HACK-46 and HACK-47).
//
// nextHandoffAction is pure and name-free. It reads only the session's
// lifecycle status, whether the filled form was downloaded in this view,
// and how many items the form still lists as needed: no answer, and no
// program, county, or portal name. It always returns exactly one action,
// labeled with where it happens: in the app, on an official channel, or
// with a caseworker. No program fact lives in this file. The steps that
// say how to sign the form and where to send it come from the knowledge
// base, each with its own source, through handoffCompanion.
//
// Rules built in (AGENTS.md Legal, BN-25):
// - The person signs the form and sends it in themselves. No action signs,
//   sends, submits, or faxes anything, and no copy says the app did.
// - An action only ever leads to the next BN-25 state, so a user-reported
//   state is never offered before the session is handed off.
// - No copy states or implies an eligibility outcome.

/** Where the next action happens (BN-23). */
export const HANDOFF_WHERE = ["in_app", "official_channel", "caseworker"] as const;

export type HandoffWhere = (typeof HANDOFF_WHERE)[number];

/** The plain-language label each where shows on the next-step callout. */
export const HANDOFF_WHERE_LABELS: Readonly<Record<HandoffWhere, string>> = {
  in_app: "In the app",
  official_channel: "On an official channel",
  caseworker: "With a caseworker",
};

export const HANDOFF_ACTION_KINDS = [
  "answer_remaining",
  "mark_prepared",
  "download",
  "mark_handed_off",
  "sign_and_send",
  "follow_up",
  "decision_questions",
] as const;

export type HandoffActionKind = (typeof HANDOFF_ACTION_KINDS)[number];

/** Everything the next action depends on. Nothing here identifies anyone. */
export interface HandoffState {
  readonly sessionStatus: SessionStatus;
  /** Whether the filled form was downloaded in this view. */
  readonly downloaded: boolean;
  /** How many items the prepared form still lists as needed. */
  readonly stillNeededCount: number;
}

export interface HandoffAction {
  readonly kind: HandoffActionKind;
  readonly where: HandoffWhere;
  readonly title: string;
  readonly detail: string;
  /**
   * The BN-25 state this action moves the session to, when it moves it at
   * all. It is always the state right after the current one.
   */
  readonly leadsTo?: SessionStatus;
  /** The sourced steps that spell this action out, shown right under it. */
  readonly guide?: SourcedStepKbFactGroupName;
}

const MARK_PREPARED: HandoffAction = {
  kind: "mark_prepared",
  where: "in_app",
  title: "Mark your package prepared",
  detail:
    "Nothing on the form is still listed as needed. Look it over, then " +
    "mark your package prepared.",
  leadsTo: "prepared",
};

const DOWNLOAD: HandoffAction = {
  kind: "download",
  where: "in_app",
  title: "Download your filled application",
  detail:
    "Download the filled PDF, so you have the form to sign and send in " +
    "yourself.",
};

const MARK_HANDED_OFF: HandoffAction = {
  kind: "mark_handed_off",
  where: "in_app",
  title: "Mark it handed off",
  detail:
    "You have your filled application. Mark it handed off, then sign it " +
    "and send it in yourself. The steps below show how.",
  leadsTo: "handed_off",
  guide: "submission_steps",
};

const SIGN_AND_SEND: HandoffAction = {
  kind: "sign_and_send",
  where: "official_channel",
  title: "Sign it and send it in yourself",
  detail:
    "Follow the steps below to sign and date the form and send it in " +
    "through an official channel, or to apply online instead. Each step " +
    "shows its official source. The app doesn't sign, send, or submit " +
    "anything for you. When you've sent it, tell us you submitted it " +
    "yourself.",
  leadsTo: "user_reported_submitted",
  guide: "submission_steps",
};

const FOLLOW_UP: HandoffAction = {
  kind: "follow_up",
  where: "caseworker",
  title: "Next, the agency reviews your application",
  detail:
    "You told us you sent it in. The steps below say how long a decision " +
    "can take and how to ask for a review, and the last of the signing " +
    "steps says who to ask with questions. Each one shows its official " +
    "source.",
  guide: "after_you_apply",
};

const DECISION_QUESTIONS: HandoffAction = {
  kind: "decision_questions",
  where: "caseworker",
  title: "Questions about the decision? Ask the agency",
  detail:
    "You told us a decision was made. If you have questions about it, or " +
    "think it's a mistake, the steps below say what the form says about " +
    "asking for a review, with its official source.",
  guide: "after_you_apply",
};

/** A count as the copy can say it: a whole number, never below zero. */
function stillNeeded(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function answerRemaining(count: number): HandoffAction {
  const items = count === 1 ? "1 item" : `${count} items`;
  return {
    kind: "answer_remaining",
    where: "in_app",
    title: "Answer what's still needed",
    // The review shows on the voice results stage, where the transcript
    // is gone, and on the step-by-step path, which has no conversation,
    // so this copy names no part of the page that only some paths show.
    detail:
      `The form still lists ${items} as needed, shown in the list above. ` +
      "Answer what you can, and anything you leave blank you can write in " +
      "by hand before you sign. When it looks right, mark your package " +
      "prepared.",
  };
}

/**
 * The one next action for the handoff (BN-23). Total over the BN-25
 * lifecycle: every status maps to exactly one action. In order, they are
 * answer what's still needed, mark prepared, download, mark handed off,
 * sign and send it yourself, then wait while the agency reviews it, and
 * ask the agency about a decision.
 */
export function nextHandoffAction(state: HandoffState): HandoffAction {
  switch (state.sessionStatus) {
    case "draft": {
      const count = stillNeeded(state.stillNeededCount);
      return count > 0 ? answerRemaining(count) : MARK_PREPARED;
    }
    case "prepared":
      return state.downloaded ? MARK_HANDED_OFF : DOWNLOAD;
    case "handed_off":
      return SIGN_AND_SEND;
    case "user_reported_submitted":
      return FOLLOW_UP;
    case "user_reported_decided":
      return DECISION_QUESTIONS;
  }
}

/**
 * Whether the handoff shows what to expect after the form is sent: once it
 * is handed off, and after the person reports what happened.
 */
export function showsAfterYouApply(status: SessionStatus): boolean {
  return (
    status === "handed_off" ||
    status === "user_reported_submitted" ||
    status === "user_reported_decided"
  );
}

// ---------------------------------------------------------------------------
// The sourced companion steps, from the knowledge base
// ---------------------------------------------------------------------------

export interface HandoffStepView {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly link?: { readonly label: string; readonly url: string };
  /** Exactly what the step's source card shows (BN-27). */
  readonly source: KbSourceCardView;
}

/** Both sourced lists the handoff renders. */
export interface HandoffCompanion {
  readonly submissionSteps: readonly HandoffStepView[];
  readonly afterYouApply: readonly HandoffStepView[];
}

function stepView(citation: KbStepCitation): HandoffStepView {
  const { step } = citation;
  return {
    id: step.id,
    label: step.label,
    detail: step.detail,
    ...(step.link ? { link: { label: step.link.label, url: step.link.url } } : {}),
    source: {
      title: citation.sourceTitle,
      url: citation.sourceUrl,
      retrievedAt: citation.retrievedAt,
      entryVersion: citation.entryVersion,
      entryStatus: citation.status,
      ...(citation.statusReason ? { statusReason: citation.statusReason } : {}),
    },
  };
}

/** A group fits a form when it is written for that form, or for none. */
function fitsForm(group: KbSourcedStepGroup, formId: string): boolean {
  return group.formId === undefined || group.formId === formId;
}

/**
 * The sourced steps one KB entry gives the handoff beside one form, or
 * null when it cannot back the handoff there. Both lists are needed,
 * because every action outside the app points at one of them, and a list
 * written for another form never shows, since its page references would
 * not exist on this one. A withdrawn entry is never cited as fact, so it
 * yields null. A stale entry is cited with acknowledgment, and every
 * step's source carries the status and reason for its card to show.
 */
export function handoffCompanion(
  entry: KbEntry,
  formId: string,
): HandoffCompanion | null {
  const { submission_steps: submission, after_you_apply: after } = entry.facts;
  if (
    entry.status === "withdrawn" ||
    !submission ||
    !after ||
    !fitsForm(submission, formId) ||
    !fitsForm(after, formId)
  ) {
    return null;
  }
  const options = { acknowledgeNonActive: true } as const;
  return {
    submissionSteps: citeSourcedSteps(entry, "submission_steps", options).map(stepView),
    afterYouApply: citeSourcedSteps(entry, "after_you_apply", options).map(stepView),
  };
}

/**
 * The companion for the form under review: the first entry, in the order
 * given, that can back the handoff beside it. The production list is
 * KB_ENTRIES, which the pilot seam decides (PILOT_CONFIG.kbEntryIds).
 */
export function handoffCompanionForForm(
  formId: string,
  entries: readonly KbEntry[] = KB_ENTRIES,
): HandoffCompanion | null {
  for (const entry of entries) {
    const companion = handoffCompanion(entry, formId);
    if (companion) {
      return companion;
    }
  }
  return null;
}
