import { requestPersistentStorage } from "../device-kv";
import type { AnswerStatus } from "../honesty";
import { canonicalAnswerValue } from "./answer-input";
import {
  EMPTY_CLIENT_ANSWERS,
  saveClientAnswer,
  toAnswerMap,
  type ClientAnswerRecord,
  type ClientAnswerState,
} from "./client-store";
import { buildClientState, type IntakeClientState, type IntakeProgress } from "./client-state";
import {
  loadDeviceAnswers,
  openDeviceAnswerStore,
  purgeDeviceAnswers,
  recordDeviceAnswer,
  type DeviceAnswerStoreDeps,
} from "./device-answer-store";
import { QUESTION_BY_ID } from "./spec";

// The step-by-step page's on-device intake (HACK-99). Answers live only in
// this browser: the flow engine runs here over the sealed device store
// (device-answer-store.ts), so no answer is ever sent to an endpoint. Each
// answer is checked against the question spec exactly as the server store
// checks it (answer-input.ts), then saved on the device; reloading the page
// resumes at the first unanswered question.
//
// Every outcome is told honestly. When this browser cannot keep answers
// (no secure page, no IndexedDB, storage blocked or refusing writes), the
// page still works but says the answers last only until it is closed, and
// it never claims a save, resume, or delete that did not happen.

export const DEVICE_INTAKE_COPY = {
  pageIntro:
    "A few plain-language questions, one at a time. Your answers stay on " +
    "this device and save as you go, and you can stop at any point. Nothing " +
    "you enter on this page is sent to us.",
  keptBlurb:
    "Your answers are saved on this device as you go, locked with a key " +
    "that never leaves this browser. Stop any time and pick up later in " +
    "this browser. Nothing is submitted until you decide.",
  notKeptBlurb:
    "This browser isn't keeping your answers, so they'll be gone when you " +
    "close this page. Nothing is submitted until you decide.",
  notKeptOnLoad:
    "This browser can't keep answers for this page, so they'll last only " +
    "until you close it. Nothing you enter is sent to us either way.",
  unreadableOnLoad:
    "We couldn't open the answers saved on this device, so the questions " +
    "start fresh. Your next answer replaces what couldn't be opened.",
  stoppedKeeping:
    "This browser stopped saving answers, so your answers from now on last " +
    "only until you close this page.",
  purgedElsewhere:
    "Your answers were deleted from this device in another tab or window, " +
    "so the questions start fresh.",
  busy:
    "Your answers are being changed in another tab right now, so this one " +
    "wasn't saved. Please try again.",
  invalidAnswer: "We couldn't use that answer. Please check it and try again.",
  savedForLaterKept:
    "Your answers are saved on this device. Come back in this browser any " +
    "time. Nothing is submitted until you decide.",
  savedForLaterNotKept:
    "This browser isn't keeping your answers, so they'll be gone when you " +
    "close this page. Nothing is submitted until you decide.",
  deleteButton: "Delete my answers from this device",
  deleteConfirm:
    "This deletes every answer saved on this device. It can't be undone.",
  deleteYes: "Yes, delete them",
  deleteNo: "Keep them",
  deleted: "Deleted. None of your answers are left on this device.",
  clearedNotKept:
    "Cleared from this page. This browser wasn't keeping your answers " +
    "during this visit.",
  deleteUnconfirmed:
    "We couldn't confirm your answers were deleted. To be sure, clear this " +
    "site's data in your browser settings.",
} as const;

/** What the page holds for the on-device intake. */
export interface DeviceIntake {
  /** The device store, or null when this browser cannot keep answers. */
  readonly store: DeviceAnswerStoreDeps | null;
  /**
   * Whether new answers are written to the store. False once a write has
   * failed: the rest of the visit stays in memory, and the page says so.
   */
  readonly keeping: boolean;
  /** Whether answers are known to be kept on the device (loaded or saved). */
  readonly stored: boolean;
  /** Every answer the page holds, pii values included. Never rendered or sent. */
  readonly answers: ClientAnswerState;
  /** What the page renders: the flow over these answers, pii values stripped. */
  readonly view: IntakeClientState;
}

function intakeOf(
  store: DeviceAnswerStoreDeps | null,
  keeping: boolean,
  stored: boolean,
  answers: ClientAnswerState,
): DeviceIntake {
  return {
    store,
    keeping: store !== null && keeping,
    stored,
    answers,
    view: buildClientState(toAnswerMap(answers)),
  };
}

/** Whether answers given now will still be here after a reload. */
export function keepsAnswers(intake: DeviceIntake): boolean {
  return intake.store !== null && intake.keeping;
}

export interface DeviceIntakeLoad {
  readonly intake: DeviceIntake;
  /** What to tell the person about storage on load; empty when there is nothing to say. */
  readonly notice: string;
}

/** Open the device store and resume whatever answers it keeps. Never rejects. */
export async function loadDeviceIntake(
  open: () => Promise<DeviceAnswerStoreDeps | null> = openDeviceAnswerStore,
): Promise<DeviceIntakeLoad> {
  const store = await open().catch(() => null);
  if (store === null) {
    return {
      intake: intakeOf(null, false, false, EMPTY_CLIENT_ANSWERS),
      notice: DEVICE_INTAKE_COPY.notKeptOnLoad,
    };
  }
  try {
    const loaded = await loadDeviceAnswers(store);
    switch (loaded.status) {
      case "none":
        return { intake: intakeOf(store, true, false, EMPTY_CLIENT_ANSWERS), notice: "" };
      case "ok":
        return { intake: intakeOf(store, true, true, loaded.state), notice: "" };
      case "unreadable":
        return {
          intake: intakeOf(store, true, false, EMPTY_CLIENT_ANSWERS),
          notice: DEVICE_INTAKE_COPY.unreadableOnLoad,
        };
    }
  } catch {
    return {
      intake: intakeOf(null, false, false, EMPTY_CLIENT_ANSWERS),
      notice: DEVICE_INTAKE_COPY.notKeptOnLoad,
    };
  }
}

/** The status line after an answer: what was saved, and where. */
export function answerNotice(
  status: AnswerStatus,
  progress: IntakeProgress,
  kept: boolean,
): string {
  if (kept) {
    return status === "unknown"
      ? "Marked as not sure. You can come back to it."
      : `Saved on this device. ${progress.answered} of ${progress.total} answered.`;
  }
  const lead =
    status === "unknown"
      ? "Marked as not sure for this visit."
      : `Noted for this visit. ${progress.answered} of ${progress.total} answered.`;
  return `${lead} This browser isn't keeping answers, so they'll be gone when you close this page.`;
}

export type DeviceAnswerResult =
  /** The answer is in the page's state (and on the device when `intake` keeps answers). */
  | { readonly kind: "saved"; readonly intake: DeviceIntake; readonly notice: string }
  /** The value is not a valid answer to the question; nothing changed. */
  | { readonly kind: "invalid"; readonly message: string }
  /** The answers were deleted in another tab; the page starts fresh. Nothing was saved. */
  | { readonly kind: "purged"; readonly intake: DeviceIntake; readonly notice: string }
  /** Other tabs kept changing the answers; nothing changed. */
  | { readonly kind: "busy"; readonly message: string };

/**
 * Answer one question on the device. The value is checked and canonicalized
 * against the question spec first (as POST /api/intake/answer does), so
 * nothing invalid is kept; an unknown answer keeps no value at all.
 */
export async function answerOnDevice(
  intake: DeviceIntake,
  questionId: string,
  status: AnswerStatus,
  value: unknown,
  persist: () => Promise<boolean> = requestPersistentStorage,
): Promise<DeviceAnswerResult> {
  if (!Object.hasOwn(QUESTION_BY_ID, questionId)) {
    return { kind: "invalid", message: DEVICE_INTAKE_COPY.invalidAnswer };
  }
  let stored: unknown = null;
  if (status !== "unknown") {
    const canonical = canonicalAnswerValue(QUESTION_BY_ID[questionId], value);
    if (canonical === null) {
      return { kind: "invalid", message: DEVICE_INTAKE_COPY.invalidAnswer };
    }
    stored = canonical;
  }
  const record: ClientAnswerRecord = {
    questionId,
    status,
    provenance: "user_supplied",
    value: stored,
  };
  const inMemory = (notice?: string): DeviceAnswerResult => {
    const next = intakeOf(intake.store, false, intake.stored, saveClientAnswer(intake.answers, record));
    return {
      kind: "saved",
      intake: next,
      notice: notice ?? answerNotice(status, next.view.progress, false),
    };
  };
  if (!keepsAnswers(intake) || intake.store === null) {
    return inMemory();
  }
  let result;
  try {
    result = await recordDeviceAnswer(intake.store, record, { expectStored: intake.stored });
  } catch {
    // Storage refused the write (full, blocked, or closed): keep going in
    // memory for the rest of this visit, and say so.
    return inMemory(DEVICE_INTAKE_COPY.stoppedKeeping);
  }
  switch (result.status) {
    case "saved": {
      if (!intake.stored) {
        // Ask once, on the first answer kept, that the browser not evict
        // the store under storage pressure. Best effort, never awaited.
        void persist().catch(() => false);
      }
      const next = intakeOf(intake.store, true, true, result.state);
      return { kind: "saved", intake: next, notice: answerNotice(status, next.view.progress, true) };
    }
    case "purged":
      return {
        kind: "purged",
        intake: intakeOf(intake.store, true, false, EMPTY_CLIENT_ANSWERS),
        notice: DEVICE_INTAKE_COPY.purgedElsewhere,
      };
    case "busy":
      return { kind: "busy", message: DEVICE_INTAKE_COPY.busy };
  }
}

/** The "save and finish later" confirmation: answers are already saved as given. */
export function saveForLaterNotice(intake: DeviceIntake): string {
  return keepsAnswers(intake)
    ? DEVICE_INTAKE_COPY.savedForLaterKept
    : DEVICE_INTAKE_COPY.savedForLaterNotKept;
}

export interface DeviceDeleteResult {
  readonly intake: DeviceIntake;
  /** True when the answers are verifiably gone from the device (or were never kept). */
  readonly deleted: boolean;
  readonly notice: string;
}

/**
 * Delete every answer from the device and from the page. With no device
 * store the answers only lived in this page, so clearing it is the whole
 * delete. When the device delete cannot be confirmed, the page keeps what it
 * shows and says so rather than claiming a delete that may not have happened.
 */
export async function deleteDeviceIntake(intake: DeviceIntake): Promise<DeviceDeleteResult> {
  if (intake.store === null) {
    return {
      intake: intakeOf(null, false, false, EMPTY_CLIENT_ANSWERS),
      deleted: true,
      notice: DEVICE_INTAKE_COPY.clearedNotKept,
    };
  }
  const deleted = await purgeDeviceAnswers(intake.store);
  if (!deleted) {
    return { intake, deleted: false, notice: DEVICE_INTAKE_COPY.deleteUnconfirmed };
  }
  return {
    intake: intakeOf(intake.store, intake.keeping, false, EMPTY_CLIENT_ANSWERS),
    deleted: true,
    notice: DEVICE_INTAKE_COPY.deleted,
  };
}
