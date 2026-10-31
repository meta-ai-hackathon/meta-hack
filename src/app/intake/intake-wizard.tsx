"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ClientQuestion, IntakeClientState } from "../../lib/intake/client-state";
import {
  DEVICE_INTAKE_COPY,
  answerOnDevice,
  askToKeepAnswers,
  deleteDeviceIntake,
  keepingBlurb,
  keepsAnswers,
  loadDeviceIntake,
  privateAnswerNote,
  refreshDeviceIntake,
  saveForLaterNotice,
  type DeviceIntake,
} from "../../lib/intake/device-intake";
import { AnswerStatusBadge } from "../../components/answer-status-badge";
import { StatusRegion } from "../../components/status-region";
import { QuestionView } from "./question-view";

// Intake wizard (BN-09 / HACK-37): one question per screen, in spec order,
// driven by the flow engine. Every screen saves immediately (no explicit
// save step); progress shows answered vs remaining; the review screen
// renders stored answers with their honest tri-state badges.
//
// Where answers are kept depends on `persistence` (HACK-99):
// - "device" (the step-by-step page): answers never leave the browser. The
//   flow engine runs here over the sealed on-device store, and the person
//   can delete everything from the device. Copy follows what the browser
//   actually managed to keep.
// - "server" (the default, for the consent-declined conversation page,
//   whose match and review sections still read the server session until
//   HACK-95 moves them on-device): answers go to the /api/intake routes.

type Wizard =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; state: IntakeClientState };

const GENERIC_ERROR = "Something went wrong on our side. Please try again.";

/** Where the wizard keeps answers. See the header comment. */
export type IntakePersistence = "server" | "device";

const SERVER_SAVE_BLURB =
  "Your answers save as you go on the app's server. Stop any time and pick " +
  "up later in this browser — nothing is submitted until you decide.";

/**
 * How long after moving to a new question a click is ignored (device mode).
 * A device save finishes within milliseconds, so the second click of a
 * double-click would otherwise land on the next question's buttons.
 */
const ADVANCE_SETTLE_MS = 400;

/**
 * Continue semantics after an answer: the first unanswered question AFTER
 * the one just answered in the fresh visible list (skips may have changed
 * it); if none, the review screen. Landing on the global first-unanswered
 * would bounce back to optional questions the person already passed.
 */
function nextUnansweredAfter(state: IntakeClientState, questionId: string): number {
  const justAnswered = state.questions.findIndex(
    (candidate) => candidate.id === questionId,
  );
  for (let i = justAnswered + 1; i < state.questions.length; i += 1) {
    if (!state.answers[state.questions[i].id]) {
      return i;
    }
  }
  return state.questions.length;
}

function isEmptyDraft(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string" && value.trim() === "") {
    return true;
  }
  return Array.isArray(value) && value.length === 0;
}

/** Human-readable rendering of a stored answer value using spec labels. */
function displayValue(question: ClientQuestion, value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (question.type === "boolean") {
    return value === true ? "Yes" : "No";
  }
  if (Array.isArray(value)) {
    return value
      .map(
        (item) =>
          question.options?.find((option) => option.value === item)?.label ??
          String(item),
      )
      .join(", ");
  }
  if (question.options) {
    return (
      question.options.find((option) => option.value === value)?.label ??
      String(value)
    );
  }
  return String(value);
}

/**
 * The "no requirement to finish in one sitting" affordance (BN-13). `note`
 * is what pressing the button may also do; it is shown, and read as the
 * button's description, before the press.
 */
function SaveForLater(props: {
  onSave: () => void;
  busy: boolean;
  saving: boolean;
  blurb: string;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-surface-border pt-4">
      <p className="text-sm text-muted">{props.blurb}</p>
      {props.note ? (
        <p id="intake-save-note" className="text-sm text-muted">
          {props.note}
        </p>
      ) : null}
      <button
        type="button"
        onClick={props.onSave}
        disabled={props.busy}
        aria-describedby={props.note ? "intake-save-note" : undefined}
        className="self-start rounded-full border border-surface-border bg-surface px-4 py-2 text-sm font-medium hover:bg-teal-soft disabled:opacity-50"
      >
        {props.saving ? "Saving…" : "Save and finish later"}
      </button>
      {props.children}
    </div>
  );
}

/**
 * Delete every answer from this device (HACK-99), behind one confirming
 * step because it cannot be undone.
 */
function DeleteFromDevice(props: {
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Opening the confirmation moves focus to its safe choice, so keyboard
  // and screen-reader users land inside it (the group's label is read).
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.confirming) {
      keepRef.current?.focus();
    }
  }, [props.confirming]);
  if (!props.confirming) {
    return (
      <button
        type="button"
        data-delete-from-device
        onClick={props.onAsk}
        disabled={props.busy}
        className="self-start text-sm text-muted underline hover:text-foreground disabled:opacity-50"
      >
        {DEVICE_INTAKE_COPY.deleteButton}
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-labelledby="intake-delete-confirm"
      className="flex flex-col gap-2"
    >
      <p id="intake-delete-confirm" className="text-sm">
        {DEVICE_INTAKE_COPY.deleteConfirm}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={props.onConfirm}
          disabled={props.busy}
          className="rounded-full border border-surface-border bg-surface px-4 py-2 text-sm font-medium hover:bg-teal-soft disabled:opacity-50"
        >
          {props.busy ? "Deleting…" : DEVICE_INTAKE_COPY.deleteYes}
        </button>
        <button
          ref={keepRef}
          type="button"
          onClick={props.onCancel}
          disabled={props.busy}
          className="rounded-full px-4 py-2 text-sm text-muted underline hover:text-foreground disabled:opacity-50"
        >
          {DEVICE_INTAKE_COPY.deleteNo}
        </button>
      </div>
    </div>
  );
}

export function IntakeWizard(props: {
  /**
   * Optional callback fired after each successful answer save — lets an
   * embedding surface (the consent-declined conversation page) refresh
   * match/review sections that read the stored answers.
   */
  readonly onAnswersChanged?: () => void;
  /** Where answers are kept; "server" when omitted. See the header comment. */
  readonly persistence?: IntakePersistence;
} = {}) {
  const persistence: IntakePersistence = props.persistence ?? "server";
  const [wizard, setWizard] = useState<Wizard>({ phase: "loading" });
  const [current, setCurrent] = useState(0);
  const [draftValue, setDraftValue] = useState<unknown>(undefined);
  const [bestGuess, setBestGuess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingForLater, setSavingForLater] = useState(false);
  const [notice, setNotice] = useState("");
  const [questionError, setQuestionError] = useState<string | undefined>(
    undefined,
  );
  // The on-device intake (persistence "device"): the store handle and every
  // answer, pii values included. Only its pii-stripped view is rendered.
  const [deviceIntake, setDeviceIntake] = useState<DeviceIntake | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Where focus goes after a delete: back into the questions, or back to
  // the delete button when it could not be confirmed. The sequence number
  // makes each request a new value, so the effect runs once per delete.
  const [focusAfterDelete, setFocusAfterDelete] = useState<{
    readonly target: "question" | "delete";
    readonly seq: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Read only in event handlers: when the page last moved to a question
  // (the double-click guard), and the latest device state and busy flags
  // for the refresh-on-return listener.
  const advancedAt = useRef(0);
  const lastPointerAt = useRef(0);
  const deviceRef = useRef<DeviceIntake | null>(null);
  const activityRef = useRef(false);
  // Whether this visit already asked the browser to keep the answers: Save
  // and finish later asks at most once a visit, and the note that says it
  // may ask goes away once it has (HACK-113).
  const [askedToKeep, setAskedToKeep] = useState(false);
  const applyRef = useRef<
    (intake: DeviceIntake, message: string, options: { readonly keepDraft: boolean }) => void
  >(() => undefined);

  useEffect(() => {
    deviceRef.current = deviceIntake;
  }, [deviceIntake]);
  useEffect(() => {
    activityRef.current = busy || deleting || savingForLater;
  }, [busy, deleting, savingForLater]);

  /**
   * Move to a question of a (possibly fresh) server state, initializing the
   * draft from the stored answer in the same render cycle — answered
   * non-pii questions prefill; pii answers are never displayed.
   */
  function goTo(next: number, source: IntakeClientState): void {
    const question = source.questions[next];
    const stored = question ? source.answers[question.id] : undefined;
    const hasValue =
      stored !== undefined &&
      !question.pii &&
      stored.value !== null &&
      stored.value !== undefined;
    setCurrent(next);
    setDraftValue(hasValue ? stored.value : undefined);
    setBestGuess(hasValue && stored.status === "unverified");
    setQuestionError(undefined);
  }

  /**
   * Move on from the question just handled. In device mode this also starts
   * the double-click guard, because the next question's buttons appear
   * where the person just clicked.
   */
  function advanceTo(next: number, source: IntakeClientState): void {
    goTo(next, source);
    if (persistence === "device") {
      advancedAt.current = performance.now();
    }
  }

  /**
   * In device mode, a pointer press that lands just after moving on belongs
   * to the last question: the second click of a double-click, or a double
   * tap. Keyboard activation is never held back, so a fast Enter right after
   * the screen changes still answers the question now on screen.
   */
  function tooSoonAfterAdvance(): boolean {
    return (
      persistence === "device" &&
      lastPointerAt.current >= advancedAt.current &&
      performance.now() - advancedAt.current < ADVANCE_SETTLE_MS
    );
  }

  function notePointer(): void {
    lastPointerAt.current = performance.now();
  }

  useEffect(() => {
    let cancelled = false;
    if (persistence === "device") {
      // Resume from this device only: no request carries or fetches answers.
      void loadDeviceIntake().then(({ intake, notice }) => {
        if (cancelled) {
          return;
        }
        setDeviceIntake(intake);
        setWizard({ phase: "ready", state: intake.view });
        goTo(intake.view.currentIndex ?? intake.view.questions.length, intake.view);
        setNotice(notice);
      });
      return () => {
        cancelled = true;
      };
    }
    fetch("/api/intake/state")
      .then(async (response) => {
        const data = await response.json();
        if (cancelled) {
          return;
        }
        if (!response.ok || data.error) {
          setWizard({
            phase: "error",
            message: data?.error?.message ?? GENERIC_ERROR,
          });
          return;
        }
        setWizard({ phase: "ready", state: data });
        goTo(data.currentIndex ?? data.questions.length, data);
      })
      .catch(() => {
        if (!cancelled) {
          setWizard({ phase: "error", message: GENERIC_ERROR });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [persistence]);

  // Device mode: when the page comes back into view, pick up what another
  // tab or window changed (new answers, or a delete) so this page never
  // shows answers as saved after they were deleted elsewhere.
  useEffect(() => {
    if (persistence !== "device") {
      return;
    }
    let running = false;
    async function recheck(): Promise<void> {
      const intake = deviceRef.current;
      if (!intake || running || activityRef.current || document.visibilityState !== "visible") {
        return;
      }
      running = true;
      try {
        const refreshed = await refreshDeviceIntake(intake);
        if (deviceRef.current !== intake) {
          return;
        }
        if (refreshed.changed) {
          applyRef.current(refreshed.intake, refreshed.notice, { keepDraft: !refreshed.purged });
        } else if (refreshed.intake !== intake) {
          setDeviceIntake(refreshed.intake);
        }
      } finally {
        running = false;
      }
    }
    const onVisible = () => void recheck();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [persistence]);

  // When the delete confirmation closes (after a delete, or on Keep them),
  // put focus somewhere useful instead of losing it with the button that
  // just disappeared.
  useEffect(() => {
    if (focusAfterDelete === null) {
      return;
    }
    const root = rootRef.current;
    const target =
      focusAfterDelete.target === "question"
        ? root?.querySelector<HTMLElement>("fieldset input, fieldset select, fieldset textarea, fieldset button")
        : root?.querySelector<HTMLElement>("[data-delete-from-device]");
    target?.focus();
  }, [focusAfterDelete]);

  /**
   * Show a device state that changed outside a save (another tab's answers
   * or delete): keep the person on the question they were on when it still
   * exists, otherwise go to the first unanswered one. With `keepDraft` (an
   * update, not a delete), staying on the same question keeps whatever the
   * person was in the middle of typing; only its position may move.
   */
  function applyDeviceIntake(
    intake: DeviceIntake,
    message: string,
    options: { readonly keepDraft: boolean },
  ): void {
    setDeviceIntake(intake);
    setWizard({ phase: "ready", state: intake.view });
    const currentId =
      wizard.phase === "ready" ? wizard.state.questions[current]?.id : undefined;
    const stillThere =
      currentId === undefined
        ? -1
        : intake.view.questions.findIndex((question) => question.id === currentId);
    if (options.keepDraft && stillThere >= 0) {
      setCurrent(stillThere);
    } else {
      goTo(
        stillThere >= 0
          ? stillThere
          : (intake.view.currentIndex ?? intake.view.questions.length),
        intake.view,
      );
    }
    setNotice(message);
  }
  // The refresh-on-return listener outlives renders; it calls the latest
  // applyDeviceIntake (which reads the current screen) through this ref.
  useEffect(() => {
    applyRef.current = applyDeviceIntake;
  });

  async function submitAnswer(
    status: "known" | "unverified" | "unknown",
  ): Promise<void> {
    if (wizard.phase !== "ready") {
      return;
    }
    const question = wizard.state.questions[current];
    if (!question || tooSoonAfterAdvance()) {
      return;
    }
    setBusy(true);
    setQuestionError(undefined);
    if (persistence === "device") {
      try {
        await answerOnThisDevice(question.id, status);
      } catch {
        setQuestionError(GENERIC_ERROR);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const response = await fetch("/api/intake/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          status,
          value: status === "unknown" ? null : draftValue,
        }),
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        setQuestionError(data?.error?.message ?? GENERIC_ERROR);
        return;
      }
      setWizard({ phase: "ready", state: data });
      props.onAnswersChanged?.();
      goTo(nextUnansweredAfter(data, question.id), data);
      setNotice(
        status === "unknown"
          ? "Marked as not sure. You can come back to it."
          : `Saved. ${data.progress.answered} of ${data.progress.total} answered.`,
      );
    } catch {
      setQuestionError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Save one answer on this device (persistence "device"). Nothing is sent
   * anywhere; the outcome's copy says whether the device kept it. By default
   * the page moves on to the next unanswered question; with `advance: false`
   * ("Save and finish later") it stays on the question just saved.
   */
  async function answerOnThisDevice(
    questionId: string,
    status: "known" | "unverified" | "unknown",
    options: { readonly advance?: boolean } = {},
  ): Promise<DeviceIntake | null> {
    const intake = deviceIntake;
    if (!intake) {
      return null;
    }
    const result = await answerOnDevice(
      intake,
      questionId,
      status,
      status === "unknown" ? null : draftValue,
    );
    if (result.kind === "invalid" || result.kind === "busy") {
      // Nothing changed: the draft stays so the person can fix or retry it.
      setQuestionError(result.message);
      return null;
    }
    setDeviceIntake(result.intake);
    const data = result.intake.view;
    setWizard({ phase: "ready", state: data });
    props.onAnswersChanged?.();
    if (result.kind === "purged") {
      goTo(data.currentIndex ?? data.questions.length, data);
    } else if (options.advance === false) {
      // Stay on the question just saved; if skip logic now hides it, go to
      // the next unanswered one as a normal save would.
      const same = data.questions.findIndex((question) => question.id === questionId);
      goTo(same >= 0 ? same : nextUnansweredAfter(data, questionId), data);
    } else {
      advanceTo(nextUnansweredAfter(data, questionId), data);
    }
    setNotice(result.notice);
    return result.kind === "saved" ? result.intake : null;
  }

  /** Delete every answer from this device and this page (persistence "device"). */
  async function deleteFromThisDevice(): Promise<void> {
    const intake = deviceIntake;
    if (!intake || deleting || busy || savingForLater) {
      return;
    }
    setDeleting(true);
    try {
      const result = await deleteDeviceIntake(intake);
      setDeviceIntake(result.intake);
      if (result.intake.answers !== intake.answers) {
        setWizard({ phase: "ready", state: result.intake.view });
        goTo(0, result.intake.view);
      }
      setNotice(result.notice);
      setFocusAfterDelete((previous) => ({
        target: result.deleted ? "question" : "delete",
        seq: (previous?.seq ?? 0) + 1,
      }));
    } catch {
      setNotice(DEVICE_INTAKE_COPY.deleteUnconfirmed);
      setFocusAfterDelete((previous) => ({ target: "delete", seq: (previous?.seq ?? 0) + 1 }));
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  /**
   * Save and finish later (BN-13): make sure a session exists right now —
   * even before the first answer — so returning to /intake on this device
   * resumes exactly where the visitor left off. The session token lives in
   * the httpOnly bn_session cookie; nothing is ever submitted by saving.
   */
  async function saveAndFinishLater(): Promise<void> {
    // Guard against racing an in-flight answer POST: whichever response
    // landed last would overwrite the wizard with an older DB snapshot.
    if (wizard.phase !== "ready" || savingForLater || busy) {
      return;
    }
    if (persistence === "device") {
      await saveForLaterOnDevice();
      return;
    }
    setSavingForLater(true);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        setNotice(data?.error?.message ?? GENERIC_ERROR);
        return;
      }
      setWizard({ phase: "ready", state: data.state });
      setNotice(
        "Saved. Come back in this browser any time — nothing is submitted until you decide.",
      );
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setSavingForLater(false);
    }
  }

  /**
   * Save and finish later on the device: first save the answer on screen,
   * if there is one, so "saved" covers what the person just typed; then
   * re-read the store, so a delete in another tab is never confirmed as a
   * save; then say honestly what this browser is keeping. Only then, with
   * the person's answers kept on this device, ask the browser to keep this
   * site's storage. The note by the button said beforehand that it may ask.
   */
  async function saveForLaterOnDevice(): Promise<void> {
    if (wizard.phase !== "ready" || !deviceIntake || deleting) {
      return;
    }
    setSavingForLater(true);
    try {
      let latest: DeviceIntake | null = deviceIntake;
      const question = wizard.state.questions[current];
      if (question && !isEmptyDraft(draftValue)) {
        latest = await answerOnThisDevice(question.id, bestGuess ? "unverified" : "known", {
          advance: false,
        });
        if (latest === null) {
          // Not saved (invalid, busy, or deleted elsewhere): what to say is already shown.
          return;
        }
      }
      const refreshed = await refreshDeviceIntake(latest);
      if (refreshed.changed) {
        applyDeviceIntake(refreshed.intake, refreshed.notice, { keepDraft: !refreshed.purged });
        return;
      }
      setDeviceIntake(refreshed.intake);
      setNotice(saveForLaterNotice(refreshed.intake));
      if (!askedToKeep && askToKeepAnswers(refreshed.intake)) {
        setAskedToKeep(true);
      }
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setSavingForLater(false);
    }
  }

  function handleContinue(): void {
    if (wizard.phase !== "ready" || tooSoonAfterAdvance()) {
      return;
    }
    const question = wizard.state.questions[current];
    if (!question) {
      return;
    }
    if (isEmptyDraft(draftValue)) {
      if (wizard.state.answers[question.id]) {
        // Already answered; nothing new entered — just move on.
        advanceTo(current + 1, wizard.state);
        return;
      }
      if (question.required) {
        setQuestionError(
          "This one is needed to continue. Pick an option or choose I'm not sure.",
        );
        return;
      }
      advanceTo(current + 1, wizard.state);
      return;
    }
    void submitAnswer(bestGuess ? "unverified" : "known");
  }

  if (wizard.phase === "loading") {
    return (
      <div data-intake-wizard className="flex flex-col gap-4">
        <p role="status">Loading your questions…</p>
      </div>
    );
  }

  if (wizard.phase === "error") {
    return (
      <div data-intake-wizard className="flex flex-col gap-4">
        <StatusRegion message={wizard.message} />
      </div>
    );
  }

  const { state } = wizard;
  const shownDevice = persistence === "device" ? deviceIntake : null;
  // Device mode keeps one status region in the same place on every screen,
  // so an outcome that also changes the screen (a delete, a delete in
  // another tab) is still announced. Server mode keeps its own placement.
  const deviceStatus =
    persistence === "device" ? <StatusRegion message={notice} /> : null;
  const screenStatus =
    persistence === "device" ? null : <StatusRegion message={notice} />;
  const saveForLaterSection = (
    <SaveForLater
      onSave={() => void saveAndFinishLater()}
      busy={savingForLater || busy || deleting}
      saving={savingForLater}
      blurb={shownDevice ? keepingBlurb(shownDevice) : SERVER_SAVE_BLURB}
      note={
        shownDevice && keepsAnswers(shownDevice) && !askedToKeep
          ? DEVICE_INTAKE_COPY.keepPrompt
          : undefined
      }
    >
      {shownDevice ? (
        <DeleteFromDevice
          confirming={confirmingDelete}
          busy={deleting || busy || savingForLater}
          onAsk={() => setConfirmingDelete(true)}
          onConfirm={() => void deleteFromThisDevice()}
          onCancel={() => {
            setConfirmingDelete(false);
            setFocusAfterDelete((previous) => ({
              target: "delete",
              seq: (previous?.seq ?? 0) + 1,
            }));
          }}
        />
      ) : null}
    </SaveForLater>
  );

  if (current >= state.questions.length) {
    const answered = state.questions.filter(
      (question) => state.answers[question.id],
    );
    const remaining = state.questions.filter(
      (question) => !state.answers[question.id],
    );
    return (
      <div
        data-intake-wizard
        ref={rootRef}
        onPointerDownCapture={notePointer}
        className="flex flex-col gap-6"
      >
        {deviceStatus}
        <h2 className="font-display text-2xl font-bold">All questions answered for now</h2>
        <p className="max-w-xl text-muted">
          Nothing is submitted — you decide what happens next.
        </p>
        {screenStatus}
        <ul className="flex flex-col gap-3">
          {answered.map((question) => {
            const answer = state.answers[question.id];
            return (
              <li
                key={question.id}
                className="flex flex-col gap-1 rounded-xl border border-surface-border bg-surface p-3 text-left"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{question.prompt}</span>
                  <AnswerStatusBadge status={answer.status} />
                </div>
                <p className="text-sm text-muted">
                  {question.pii
                    ? shownDevice
                      ? privateAnswerNote(shownDevice)
                      : "Saved privately — not shown again."
                    : displayValue(question, answer.value) ||
                      "No answer recorded."}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    goTo(state.questions.indexOf(question), state)
                  }
                  className="self-start text-sm text-muted underline hover:text-foreground"
                >
                  Review this answer
                </button>
              </li>
            );
          })}
        </ul>
        {remaining.length > 0 ? (
          <section
            aria-labelledby="intake-remaining-heading"
            className="flex flex-col gap-2"
          >
            <h3 id="intake-remaining-heading" className="text-lg font-semibold">
              Still open
            </h3>
            <ul className="flex flex-col gap-2">
              {remaining.map((question) => (
                <li key={question.id} className="flex items-center gap-2">
                  <span>{question.prompt}</span>
                  <button
                    type="button"
                    onClick={() =>
                      goTo(state.questions.indexOf(question), state)
                    }
                    className="text-sm text-muted underline hover:text-foreground"
                  >
                    Answer
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {saveForLaterSection}
      </div>
    );
  }

  const question = state.questions[current];
  const answer = state.answers[question.id];
  const { progress } = state;

  return (
    <div
      data-intake-wizard
      ref={rootRef}
      onPointerDownCapture={notePointer}
      className="flex flex-col gap-6"
    >
      {deviceStatus}
      <div className="flex flex-col gap-1">
        <p
          id="intake-progress-text"
          className="text-sm text-muted"
        >
          Answered {progress.answered} of {progress.total} questions
          {progress.remaining > 0 ? ` — ${progress.remaining} to go` : ""}
        </p>
        <progress
          aria-labelledby="intake-progress-text"
          value={progress.answered}
          max={progress.total}
          className="h-2 w-full"
        />
      </div>
      {screenStatus}
      <QuestionView
        question={question}
        answer={answer}
        value={draftValue}
        onValueChange={setDraftValue}
        bestGuess={bestGuess}
        onBestGuessChange={setBestGuess}
        onNotSure={() => void submitAnswer("unknown")}
        onSubmit={handleContinue}
        onSkip={() => {
          if (!tooSoonAfterAdvance()) {
            advanceTo(current + 1, state);
          }
        }}
        busy={busy || savingForLater || deleting}
        error={questionError}
      />
      {current > 0 ? (
        <button
          type="button"
          onClick={() => goTo(current - 1, state)}
          className="self-start text-base text-muted underline hover:text-foreground"
        >
          Back
        </button>
      ) : null}
      {saveForLaterSection}
    </div>
  );
}
