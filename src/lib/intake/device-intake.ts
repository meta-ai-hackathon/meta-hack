import {
  DEVICE_STORAGE_TIMEOUT_MS,
  DeviceStorageTimeoutError,
  requestPersistentStorage,
  withDeadline,
} from "../device-kv";
import type { AnswerStatus } from "../honesty";
import { canonicalAnswerValue } from "./answer-input";
import {
  EMPTY_CLIENT_ANSWERS,
  hasAnyAnswer,
  saveClientAnswer,
  serializeClientAnswers,
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
  type DeviceAnswerSave,
  type DeviceAnswerStoreDeps,
  type DeviceAnswerStoreOpen,
  type DeviceAnswersLoad,
} from "./device-answer-store";
import { QUESTION_BY_ID } from "./spec";

// The step-by-step page's on-device intake (HACK-99). Answers live only in
// this browser: the flow engine runs here over the sealed device store
// (device-answer-store.ts), so no answer is ever sent to an endpoint. Each
// answer is checked against the question spec exactly as the server store
// checks it (answer-input.ts), then saved on the device; reloading the page
// resumes at the first unanswered question.
//
// Every outcome is told honestly, and what the page says depends on what
// the browser actually did (DeviceKeeping below). It never claims a save,
// resume, or delete that did not happen, and it never says answers are gone
// while some are still stored on the device.

/**
 * Where answers given now end up:
 * - "kept": saved on this device as they are given.
 * - "unsupported": this browser can't keep anything (no IndexedDB, or no
 *   Web Crypto off https), so nothing was ever stored here.
 * - "unavailable": device storage didn't open, or couldn't be read, on this
 *   visit. New answers live only in this page; answers from an earlier
 *   visit may still be stored.
 * - "stopped": a save failed mid-visit. New answers live only in this page;
 *   the ones saved before the failure stay on the device.
 */
export type DeviceKeeping = "kept" | "unsupported" | "unavailable" | "stopped";

export const DEVICE_INTAKE_COPY = {
  pageIntro:
    "A few plain-language questions, one at a time. You can stop at any " +
    "point, and nothing you enter on this page is sent to us.",
  keptBlurb:
    "Your answers save in this browser as you go. Come back on this device " +
    "to pick up where you left off. Anyone who uses this browser can see " +
    "them, so delete them when you're done on a shared computer. Nothing is " +
    "submitted until you decide.",
  unsupportedBlurb:
    "This browser can't save answers, so they'll be gone when you close " +
    "this page. Nothing is submitted until you decide.",
  unavailableBlurb:
    "This browser's storage isn't working right now, so new answers last " +
    "only until you close this page. If you saved answers here before, " +
    "they're still on this device until you delete them.",
  stoppedBlurb:
    "This browser stopped saving answers. Answers it already saved stay on " +
    "this device, but changes from now on aren't saved. To remove them, use " +
    "Delete my answers from this device.",
  stoppedBlurbNothingStored:
    "This browser stopped saving answers, so they'll be gone when you close " +
    "this page. Nothing is submitted until you decide.",
  unsupportedOnLoad:
    "This browser can't save answers for this page, so they'll last only " +
    "until you close it. Nothing you enter is sent to us either way.",
  unavailableOnLoad:
    "We couldn't open this browser's storage, so answers from an earlier " +
    "visit aren't shown and new answers last only until you close this page.",
  unreadableOnLoad:
    "We couldn't open the answers saved on this device, so the questions " +
    "start fresh. Your next answer replaces what couldn't be opened.",
  resumedOnLoad:
    "Welcome back. These are the answers you saved in this browser.",
  stoppedKeeping:
    "This browser stopped saving answers. The ones you gave before are " +
    "still saved on this device, but this answer and any changes from now " +
    "on aren't.",
  stoppedKeepingNothingStored:
    "This browser stopped saving answers, so your answers from now on last " +
    "only until you close this page.",
  saveTimedOut:
    "This browser is taking too long to save, so this answer might not be " +
    "kept. Answers from now on last only until you close this page.",
  purgedElsewhere:
    "Your answers were deleted from this device in another tab or window, " +
    "so the questions start fresh.",
  updatedElsewhere: "Updated with changes made in another tab or window.",
  busy:
    "Your answers are being changed in another tab right now, so this one " +
    "wasn't saved. Please try again.",
  invalidAnswer: "We couldn't use that answer. Please check it and try again.",
  savedForLaterKept:
    "Your answers are saved in this browser. Come back on this device to " +
    "pick up where you left off. Private windows, and some browsers after " +
    "about a week without a visit, clear saved answers. Nothing is " +
    "submitted until you decide.",
  keepPrompt:
    "When you press Save and finish later, your browser may ask to let this " +
    "site store data, and saying yes keeps your answers from being cleared " +
    "to free up space.",
  deleteButton: "Delete my answers from this device",
  deleteConfirm:
    "This deletes every answer saved in this browser for this form. It " +
    "can't be undone.",
  deleteYes: "Yes, delete them",
  deleteNo: "Keep them",
  deleted: "Deleted. None of your answers are left on this device.",
  clearedNothingStored:
    "Cleared from this page. This browser can't save answers, so there was " +
    "nothing on the device to delete.",
  deleteUnconfirmed:
    "We couldn't confirm your answers were deleted from this device. To be " +
    "sure, clear this site's data in your browser settings.",
  privateKept: "Saved privately — not shown again.",
  privateNotKept: "Noted privately for this visit — not shown again.",
} as const;

/** What the page holds for the on-device intake. */
export interface DeviceIntake {
  /** The device store, or null when this visit has none. */
  readonly store: DeviceAnswerStoreDeps | null;
  /** Where answers given now end up. See DeviceKeeping. */
  readonly keeping: DeviceKeeping;
  /** Whether answers are known to be kept on the device (loaded or saved). */
  readonly stored: boolean;
  /** Every answer the page holds, pii values included. Never rendered or sent. */
  readonly answers: ClientAnswerState;
  /** What the page renders: the flow over these answers, pii values stripped. */
  readonly view: IntakeClientState;
}

function intakeOf(
  store: DeviceAnswerStoreDeps | null,
  keeping: DeviceKeeping,
  stored: boolean,
  answers: ClientAnswerState,
): DeviceIntake {
  return {
    store,
    keeping: store === null && keeping === "kept" ? "unavailable" : keeping,
    stored,
    answers,
    view: buildClientState(toAnswerMap(answers)),
  };
}

/** Whether answers given now will still be here after a reload. */
export function keepsAnswers(intake: DeviceIntake): boolean {
  return intake.store !== null && intake.keeping === "kept";
}

/** The standing line under the questions: where answers are kept right now. */
export function keepingBlurb(intake: DeviceIntake): string {
  switch (intake.keeping) {
    case "kept":
      return intake.store === null
        ? DEVICE_INTAKE_COPY.unavailableBlurb
        : DEVICE_INTAKE_COPY.keptBlurb;
    case "unsupported":
      return DEVICE_INTAKE_COPY.unsupportedBlurb;
    case "unavailable":
      return DEVICE_INTAKE_COPY.unavailableBlurb;
    case "stopped":
      return intake.stored
        ? DEVICE_INTAKE_COPY.stoppedBlurb
        : DEVICE_INTAKE_COPY.stoppedBlurbNothingStored;
  }
}

/** How a private answer is described on the review screen. */
export function privateAnswerNote(intake: DeviceIntake): string {
  return keepsAnswers(intake) ? DEVICE_INTAKE_COPY.privateKept : DEVICE_INTAKE_COPY.privateNotKept;
}

function deadline<T>(work: Promise<T>, what: string): Promise<T> {
  return withDeadline(work, DEVICE_STORAGE_TIMEOUT_MS, what);
}

export interface DeviceIntakeLoad {
  readonly intake: DeviceIntake;
  /** What to tell the person about storage on load; empty when there is nothing to say. */
  readonly notice: string;
}

/** Open the device store and resume whatever answers it keeps. Never rejects. */
export async function loadDeviceIntake(
  open: () => Promise<DeviceAnswerStoreOpen> = openDeviceAnswerStore,
): Promise<DeviceIntakeLoad> {
  let opened: DeviceAnswerStoreOpen;
  try {
    opened = await deadline(open(), "opening device storage");
  } catch {
    opened = { status: "failed" };
  }
  if (opened.status === "unsupported") {
    return {
      intake: intakeOf(null, "unsupported", false, EMPTY_CLIENT_ANSWERS),
      notice: DEVICE_INTAKE_COPY.unsupportedOnLoad,
    };
  }
  if (opened.status === "failed") {
    return {
      intake: intakeOf(null, "unavailable", false, EMPTY_CLIENT_ANSWERS),
      notice: DEVICE_INTAKE_COPY.unavailableOnLoad,
    };
  }
  const store = opened.store;
  let loaded: DeviceAnswersLoad;
  try {
    loaded = await deadline(loadDeviceAnswers(store), "reading device storage");
  } catch {
    // The store opened but could not be read. Keep the handle so a delete
    // can still try it, and say answers from before aren't shown.
    return {
      intake: intakeOf(store, "unavailable", false, EMPTY_CLIENT_ANSWERS),
      notice: DEVICE_INTAKE_COPY.unavailableOnLoad,
    };
  }
  switch (loaded.status) {
    case "none":
      return { intake: intakeOf(store, "kept", false, EMPTY_CLIENT_ANSWERS), notice: "" };
    case "ok":
      return {
        intake: intakeOf(store, "kept", true, loaded.state),
        notice: hasAnyAnswer(loaded.state) ? DEVICE_INTAKE_COPY.resumedOnLoad : "",
      };
    case "unreadable":
      return {
        intake: intakeOf(store, "kept", false, EMPTY_CLIENT_ANSWERS),
        notice: DEVICE_INTAKE_COPY.unreadableOnLoad,
      };
  }
}

/** The status line after an answer: what was saved, and where. */
export function answerNotice(
  status: AnswerStatus,
  progress: IntakeProgress,
  intake: Pick<DeviceIntake, "keeping" | "stored" | "store">,
): string {
  if (intake.keeping === "kept" && intake.store !== null) {
    return status === "unknown"
      ? "Marked as not sure. You can come back to it."
      : `Saved on this device. ${progress.answered} of ${progress.total} answered.`;
  }
  const lead =
    status === "unknown"
      ? "Marked as not sure for this visit."
      : `Noted for this visit. ${progress.answered} of ${progress.total} answered.`;
  switch (intake.keeping) {
    case "stopped":
      return intake.stored
        ? `${lead} This answer isn't saved. Answers saved before stay on this device.`
        : `${lead} This browser stopped saving answers, so they'll be gone when you close this page.`;
    case "unavailable":
    case "kept":
      return `${lead} This browser's storage isn't working right now, so this answer lasts only until you close this page.`;
    case "unsupported":
      return `${lead} This browser can't save answers, so they'll be gone when you close this page.`;
  }
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
  if (!keepsAnswers(intake) || intake.store === null) {
    const next = intakeOf(intake.store, intake.keeping, intake.stored, saveClientAnswer(intake.answers, record));
    return { kind: "saved", intake: next, notice: answerNotice(status, next.view.progress, next) };
  }
  let result: DeviceAnswerSave;
  try {
    result = await deadline(
      recordDeviceAnswer(intake.store, record, { expectStored: intake.stored }),
      "saving to device storage",
    );
  } catch (error) {
    if (error instanceof DeviceStorageTimeoutError) {
      // The deadline gave up on the write but can't abort it, so it may
      // still land. Say the answer might not be kept, and count the device
      // as possibly holding answers so the copy and the delete cover it.
      const next = intakeOf(intake.store, "stopped", true, saveClientAnswer(intake.answers, record));
      return { kind: "saved", intake: next, notice: DEVICE_INTAKE_COPY.saveTimedOut };
    }
    // Storage refused the write (full, blocked, or closed): keep going in
    // memory for the rest of this visit, and say what is still stored and
    // what is not.
    const next = intakeOf(intake.store, "stopped", intake.stored, saveClientAnswer(intake.answers, record));
    return {
      kind: "saved",
      intake: next,
      notice: intake.stored
        ? DEVICE_INTAKE_COPY.stoppedKeeping
        : DEVICE_INTAKE_COPY.stoppedKeepingNothingStored,
    };
  }
  switch (result.status) {
    case "saved": {
      const next = intakeOf(intake.store, "kept", true, result.state);
      return { kind: "saved", intake: next, notice: answerNotice(status, next.view.progress, next) };
    }
    case "purged":
      return {
        kind: "purged",
        intake: intakeOf(intake.store, "kept", false, EMPTY_CLIENT_ANSWERS),
        notice: DEVICE_INTAKE_COPY.purgedElsewhere,
      };
    case "busy":
      return { kind: "busy", message: DEVICE_INTAKE_COPY.busy };
  }
}

export interface DeviceRefresh {
  readonly intake: DeviceIntake;
  /** True when the stored answers differ from what the page showed. */
  readonly changed: boolean;
  /** True when the change was a delete made elsewhere: the page starts fresh. */
  readonly purged: boolean;
  readonly notice: string;
}

/**
 * Re-read the store, to pick up what another tab or window changed: new
 * answers, or a delete. Called when the page comes back into view and
 * before confirming a save. Leaves the page as it is when nothing changed
 * or the store can't be read. Never rejects.
 */
export async function refreshDeviceIntake(intake: DeviceIntake): Promise<DeviceRefresh> {
  const unchanged: DeviceRefresh = { intake, changed: false, purged: false, notice: "" };
  if (!keepsAnswers(intake) || intake.store === null) {
    return unchanged;
  }
  let loaded: DeviceAnswersLoad;
  try {
    loaded = await deadline(loadDeviceAnswers(intake.store), "reading device storage");
  } catch {
    return unchanged;
  }
  if (loaded.status === "none") {
    if (!intake.stored) {
      return unchanged;
    }
    return {
      intake: intakeOf(intake.store, "kept", false, EMPTY_CLIENT_ANSWERS),
      changed: true,
      purged: true,
      notice: DEVICE_INTAKE_COPY.purgedElsewhere,
    };
  }
  if (loaded.status !== "ok") {
    return unchanged;
  }
  if (serializeClientAnswers(loaded.state) === serializeClientAnswers(intake.answers)) {
    return intake.stored
      ? unchanged
      : { intake: { ...intake, stored: true }, changed: false, purged: false, notice: "" };
  }
  return {
    intake: intakeOf(intake.store, "kept", true, loaded.state),
    changed: true,
    purged: false,
    notice: DEVICE_INTAKE_COPY.updatedElsewhere,
  };
}

/** The "save and finish later" confirmation, once the answer on screen is saved. */
export function saveForLaterNotice(intake: DeviceIntake): string {
  return keepsAnswers(intake) ? DEVICE_INTAKE_COPY.savedForLaterKept : keepingBlurb(intake);
}

/**
 * Ask the browser to keep this site's storage, so it doesn't clear the
 * saved answers to free up space (HACK-113). Some browsers, Firefox among
 * them, answer with a permission prompt, so this is never asked on a plain
 * answer: the page asks only when the person presses Save and finish
 * later, after DEVICE_INTAKE_COPY.keepPrompt has said the browser may ask
 * and why, and only when this device holds their answers. Never awaited,
 * so a prompt left open can't hold up the save. Returns whether it asked.
 */
export function askToKeepAnswers(
  intake: DeviceIntake,
  persist: () => Promise<boolean> = requestPersistentStorage,
): boolean {
  if (!keepsAnswers(intake) || !intake.stored) {
    return false;
  }
  void persist().catch(() => false);
  return true;
}

export interface DeviceDeleteResult {
  readonly intake: DeviceIntake;
  /** True only when the answers are verifiably gone from the device, or none could ever be stored. */
  readonly deleted: boolean;
  readonly notice: string;
}

/**
 * Delete every answer from the device and from the page. Only a browser
 * that can't store anything skips the device: everything else runs the
 * verified purge, opening the store afresh when this visit has none, and a
 * delete that can't be confirmed says so rather than claiming success.
 */
export async function deleteDeviceIntake(
  intake: DeviceIntake,
  open: () => Promise<DeviceAnswerStoreOpen> = openDeviceAnswerStore,
): Promise<DeviceDeleteResult> {
  if (intake.keeping === "unsupported") {
    return {
      intake: intakeOf(null, "unsupported", false, EMPTY_CLIENT_ANSWERS),
      deleted: true,
      notice: DEVICE_INTAKE_COPY.clearedNothingStored,
    };
  }
  let store = intake.store;
  if (store === null) {
    try {
      const opened = await deadline(open(), "opening device storage");
      store = opened.status === "ok" ? opened.store : null;
    } catch {
      store = null;
    }
  }
  if (store === null) {
    // The answers on this page were never saved, so clearing them here is
    // real; what an earlier visit stored can't be reached, so say so.
    return {
      intake: intakeOf(null, "unavailable", false, EMPTY_CLIENT_ANSWERS),
      deleted: false,
      notice: DEVICE_INTAKE_COPY.deleteUnconfirmed,
    };
  }
  let deleted: boolean;
  try {
    deleted = await deadline(purgeDeviceAnswers(store), "deleting from device storage");
  } catch {
    deleted = false;
  }
  if (!deleted) {
    return { intake, deleted: false, notice: DEVICE_INTAKE_COPY.deleteUnconfirmed };
  }
  return {
    intake: intakeOf(store, "kept", false, EMPTY_CLIENT_ANSWERS),
    deleted: true,
    notice: DEVICE_INTAKE_COPY.deleted,
  };
}
