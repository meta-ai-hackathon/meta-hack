"use client";

import { useEffect, useState } from "react";
import type { ClientQuestion, IntakeClientState } from "../../lib/intake/serialize";
import { AnswerStatusBadge } from "../../components/answer-status-badge";
import { StatusRegion } from "../../components/status-region";
import { QuestionView } from "./question-view";

// Intake wizard (BN-09 / HACK-37): one question per screen, in spec order,
// driven by the server-side flow engine. Every screen saves immediately
// (no explicit save step); progress shows answered vs remaining; the review
// screen renders stored answers with their honest tri-state badges.

type Wizard =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; state: IntakeClientState };

const GENERIC_ERROR = "Something went wrong on our side. Please try again.";

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
function SaveForLater(props: { onSave: () => void; busy: boolean }) {
  return (
    <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Your answers save as you go on this device. Stop any time and pick up
        later — nothing is submitted until you decide.
      </p>
      <button
        type="button"
        onClick={props.onSave}
        disabled={props.busy}
        className="self-start rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
      >
        {props.busy ? "Saving…" : "Save and finish later"}
      </button>
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
} = {}) {
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
  }, []);

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
      // Continue semantics: the first unanswered question AFTER the one just
      // answered in the fresh visible list (skips may have changed it); if
      // none, the review screen. Landing on the global first-unanswered
      // would bounce back to optional questions the user already passed.
      const justAnswered = data.questions.findIndex(
        (candidate: { id: string }) => candidate.id === question.id,
      );
      let next = data.questions.length;
      for (let i = justAnswered + 1; i < data.questions.length; i += 1) {
        if (!data.answers[data.questions[i].id]) {
          next = i;
          break;
        }
      }
      goTo(next, data);
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

  if (current >= state.questions.length) {
    const answered = state.questions.filter(
      (question) => state.answers[question.id],
    );
    const remaining = state.questions.filter(
      (question) => !state.answers[question.id],
    );
    return (
      <div data-intake-wizard className="flex flex-col gap-6">
        <h2 className="text-xl font-semibold">All questions answered for now</h2>
        <p className="max-w-xl text-zinc-600 dark:text-zinc-400">
          Nothing is submitted — you decide what happens next.
        </p>
        <StatusRegion message={notice} />
        <ul className="flex flex-col gap-3">
          {answered.map((question) => {
            const answer = state.answers[question.id];
            return (
              <li
                key={question.id}
                className="flex flex-col gap-1 rounded-md border border-zinc-200 p-3 text-left dark:border-zinc-700"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{question.prompt}</span>
                  <AnswerStatusBadge status={answer.status} />
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
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
                  className="self-start text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
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
                    className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    Answer
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <SaveForLater
          onSave={() => void saveAndFinishLater()}
          busy={savingForLater || busy}
        />
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
          className="text-sm text-zinc-600 dark:text-zinc-400"
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
        busy={busy || savingForLater}
        error={questionError}
      />
      {current > 0 ? (
        <button
          type="button"
          onClick={() => goTo(current - 1, state)}
          className="self-start text-base text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Back
        </button>
      ) : null}
      <SaveForLater
        onSave={() => void saveAndFinishLater()}
        busy={savingForLater || busy}
      />
    </div>
  );
}
