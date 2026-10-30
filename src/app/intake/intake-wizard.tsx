"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ClientQuestion, IntakeClientState } from "../../lib/intake/client-state";
import {
  DEVICE_INTAKE_COPY,
  answerOnDevice,
  deleteDeviceIntake,
  keepsAnswers,
  loadDeviceIntake,
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
  "Your answers save as you go on this device. Stop any time and pick up " +
  "later — nothing is submitted until you decide.";

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

/** The "no requirement to finish in one sitting" affordance (BN-13). */
function SaveForLater(props: {
  onSave: () => void;
  busy: boolean;
  blurb: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-surface-border pt-4">
      <p className="text-sm text-muted">{props.blurb}</p>
      <button
        type="button"
        onClick={props.onSave}
        disabled={props.busy}
        className="self-start rounded-full border border-surface-border bg-surface px-4 py-2 text-sm font-medium hover:bg-teal-soft disabled:opacity-50"
      >
        {props.busy ? "Saving…" : "Save and finish later"}
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
  if (!props.confirming) {
    return (
      <button
        type="button"
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

  async function submitAnswer(
    status: "known" | "unverified" | "unknown",
  ): Promise<void> {
    if (wizard.phase !== "ready") {
      return;
    }
    const question = wizard.state.questions[current];
    if (!question) {
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
   * anywhere; the outcome's copy says whether the device kept it.
   */
  async function answerOnThisDevice(
    questionId: string,
    status: "known" | "unverified" | "unknown",
  ): Promise<void> {
    const intake = deviceIntake;
    if (!intake) {
      return;
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
      return;
    }
    setDeviceIntake(result.intake);
    const data = result.intake.view;
    setWizard({ phase: "ready", state: data });
    props.onAnswersChanged?.();
    goTo(
      result.kind === "purged"
        ? (data.currentIndex ?? data.questions.length)
        : nextUnansweredAfter(data, questionId),
      data,
    );
    setNotice(result.notice);
  }

  /** Delete every answer from this device and this page (persistence "device"). */
  async function deleteFromThisDevice(): Promise<void> {
    const intake = deviceIntake;
    if (!intake || deleting || busy) {
      return;
    }
    setDeleting(true);
    try {
      const result = await deleteDeviceIntake(intake);
      setDeviceIntake(result.intake);
      if (result.deleted) {
        setWizard({ phase: "ready", state: result.intake.view });
        goTo(0, result.intake.view);
      }
      setNotice(result.notice);
    } catch {
      setNotice(DEVICE_INTAKE_COPY.deleteUnconfirmed);
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
      // Every answer was saved (or not) as it was given; there is no session
      // to create. Say honestly whether this browser is keeping them.
      if (deviceIntake) {
        setNotice(saveForLaterNotice(deviceIntake));
      }
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
        "Saved on this device. Come back any time — nothing is submitted until you decide.",
      );
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setSavingForLater(false);
    }
  }

  function handleContinue(): void {
    if (wizard.phase !== "ready") {
      return;
    }
    const question = wizard.state.questions[current];
    if (!question) {
      return;
    }
    if (isEmptyDraft(draftValue)) {
      if (wizard.state.answers[question.id]) {
        // Already answered; nothing new entered — just move on.
        goTo(current + 1, wizard.state);
        return;
      }
      if (question.required) {
        setQuestionError(
          "This one is needed to continue. Pick an option or choose I'm not sure.",
        );
        return;
      }
      goTo(current + 1, wizard.state);
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
  const saveForLaterSection = (
    <SaveForLater
      onSave={() => void saveAndFinishLater()}
      busy={savingForLater || busy || deleting}
      blurb={
        shownDevice
          ? keepsAnswers(shownDevice)
            ? DEVICE_INTAKE_COPY.keptBlurb
            : DEVICE_INTAKE_COPY.notKeptBlurb
          : SERVER_SAVE_BLURB
      }
    >
      {shownDevice ? (
        <DeleteFromDevice
          confirming={confirmingDelete}
          busy={deleting || busy}
          onAsk={() => setConfirmingDelete(true)}
          onConfirm={() => void deleteFromThisDevice()}
          onCancel={() => setConfirmingDelete(false)}
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
      <div data-intake-wizard className="flex flex-col gap-6">
        <h2 className="font-display text-2xl font-bold">All questions answered for now</h2>
        <p className="max-w-xl text-muted">
          Nothing is submitted — you decide what happens next.
        </p>
        <StatusRegion message={notice} />
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
                    ? "Saved privately — not shown again."
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
    <div data-intake-wizard className="flex flex-col gap-6">
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
      <StatusRegion message={notice} />
      <QuestionView
        question={question}
        answer={answer}
        value={draftValue}
        onValueChange={setDraftValue}
        bestGuess={bestGuess}
        onBestGuessChange={setBestGuess}
        onNotSure={() => void submitAnswer("unknown")}
        onSubmit={handleContinue}
        onSkip={() => goTo(current + 1, state)}
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
