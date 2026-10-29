"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnswerStatusBadge } from "../../../components/answer-status-badge";
import { StatusRegion } from "../../../components/status-region";
import type { IntakeClientState } from "../../../lib/intake/serialize";

// The wizard fallback path — kept in step with the server's
// conversationErrorResponse payload (VAL-CONV-008). Defined locally: the
// conversation engine is server-only and must not enter the client bundle.
const WIZARD_FALLBACK_URL = "/intake";

// The conversational intake chat (Mission v2 M1). Typed input only in this
// milestone; voice joins later. The transcript shows the REDACTED form of
// every user turn — the server replaces private values with "you told us"
// markers before they are stored or returned, so this screen keeps them
// private by construction. A model failure renders the honest error plus the
// wizard fallback link (VAL-CONV-007/008).

interface ConversationTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly transcript: string;
}

interface ConversationErrorResponse {
  error: { code: string; message: string; wizardFallbackUrl?: string };
}

interface HistoryResponse {
  turns: ConversationTurn[];
  state: IntakeClientState;
}

interface TurnResponse {
  assistantReply: string;
  redactedUserTranscript: string;
  nextQuestionId: string | null;
  state: IntakeClientState;
}

let localTurnId = 0;
function nextLocalTurnId(): string {
  localTurnId += 1;
  return `local-turn-${localTurnId}`;
}

export function ConversationChat() {
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [state, setState] = useState<IntakeClientState | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    code: string;
    message: string;
    wizardFallbackUrl: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      try {
        const response = await fetch("/api/conversation/history");
        if (!response.ok) {
          throw new Error("history unavailable");
        }
        const data = (await response.json()) as HistoryResponse;
        if (cancelled) {
          return;
        }
        setTurns(data.turns);
        setState(data.state);
      } catch {
        if (!cancelled) {
          setNotice("We could not load your earlier conversation just now.");
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    }
    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns]);

  async function submitTurn(): Promise<void> {
    const text = draft.trim();
    if (text === "" || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const response = await fetch("/api/conversation/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const data = (await response.json()) as ConversationErrorResponse;
        setError({
          code: data.error?.code ?? "internal",
          message:
            data.error?.message ??
            "Something went wrong on our side. Please try again.",
          wizardFallbackUrl: data.error?.wizardFallbackUrl ?? WIZARD_FALLBACK_URL,
        });
        setNotice("The assistant could not reply just now.");
        return;
      }
      const data = (await response.json()) as TurnResponse;
      setTurns((previous) => [
        ...previous,
        { id: nextLocalTurnId(), role: "user", transcript: data.redactedUserTranscript },
        { id: nextLocalTurnId(), role: "assistant", transcript: data.assistantReply },
      ]);
      setState(data.state);
      setDraft("");
      setNotice(
        data.nextQuestionId
          ? "The assistant asked the next question."
          : "All questions are answered.",
      );
    } catch {
      setError({
        code: "internal",
        message: "Something went wrong on our side. Please try again.",
        wizardFallbackUrl: WIZARD_FALLBACK_URL,
      });
      setNotice("The assistant could not reply just now.");
    } finally {
      setBusy(false);
    }
  }

  const answeredQuestions = state
    ? state.questions.filter((question) => state.answers[question.id])
    : [];

  return (
    <div data-conversation-chat className="flex flex-col gap-6">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Prefer step-by-step questions?{" "}
        <Link
          href={WIZARD_FALLBACK_URL}
          className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          Use the wizard instead
        </Link>
      </p>

      <StatusRegion message={notice} />

      <section aria-labelledby="conversation-transcript-heading" className="flex flex-col gap-3">
        <h2 id="conversation-transcript-heading" className="text-lg font-semibold">
          Conversation
        </h2>
        {loaded && turns.length === 0 ? (
          <p className="max-w-xl text-zinc-600 dark:text-zinc-400">
            Say hello, or answer the first question whenever you are ready.
          </p>
        ) : null}
        <ul className="flex flex-col gap-3" data-conversation-transcript>
          {turns.map((turn) => (
            <li
              key={turn.id}
              className={
                turn.role === "user"
                  ? "self-end max-w-[85%] rounded-2xl bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "self-start max-w-[85%] rounded-2xl border border-zinc-200 px-4 py-2 dark:border-zinc-700"
              }
            >
              <span className="sr-only">
                {turn.role === "user" ? "You said:" : "The assistant said:"}
              </span>
              {turn.transcript}
            </li>
          ))}
        </ul>
        <div ref={transcriptEndRef} />
      </section>

      {error ? (
        <div
          role="alert"
          data-conversation-error
          className="flex flex-col gap-2 rounded-md border border-amber-500 bg-amber-50 p-4 text-amber-900"
        >
          <p className="font-medium">{error.message}</p>
          {error.code === "model_unavailable" || error.code === "rate_limited" ? (
            <p>
              You can keep going right now in the step-by-step form:{" "}
              <Link
                href={error.wizardFallbackUrl}
                data-wizard-fallback-link
                className="font-semibold underline"
              >
                Open the wizard
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submitTurn();
        }}
      >
        <label htmlFor="conversation-input" className="font-medium">
          Type your answer
        </label>
        <textarea
          id="conversation-input"
          name="conversation-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submitTurn();
            }
          }}
          rows={2}
          maxLength={4000}
          disabled={busy}
          aria-describedby="conversation-input-help"
          className="rounded-md border border-zinc-300 p-3 text-base dark:border-zinc-600 dark:bg-zinc-800"
        />
        <p id="conversation-input-help" className="text-sm text-zinc-600 dark:text-zinc-400">
          Private details stay private: the transcript below shows them only as
          &ldquo;you told us&rdquo; marks, never the values themselves.
        </p>
        <button
          type="submit"
          disabled={busy || draft.trim() === ""}
          className="self-start rounded-md bg-zinc-900 px-5 py-2.5 text-base font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </form>

      {state ? (
        <section
          aria-labelledby="conversation-status-heading"
          className="flex flex-col gap-2"
        >
          <h2 id="conversation-status-heading" className="text-lg font-semibold">
            Your answers so far
          </h2>
          <p
            id="conversation-progress-text"
            className="text-sm text-zinc-600 dark:text-zinc-400"
          >
            Answered {state.progress.answered} of {state.progress.total} questions
            {state.progress.remaining > 0
              ? ` — ${state.progress.remaining} to go`
              : ""}
          </p>
          <progress
            aria-labelledby="conversation-progress-text"
            value={state.progress.answered}
            max={state.progress.total}
            className="h-2 w-full"
          />
          {answeredQuestions.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {answeredQuestions.map((question) => {
                const answer = state.answers[question.id];
                return (
                  <li
                    key={question.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-700"
                  >
                    <span className="font-medium">{question.prompt}</span>
                    {answer ? <AnswerStatusBadge status={answer.status} /> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {state.complete ? (
            <p className="text-zinc-600 dark:text-zinc-400">
              Every question is answered. Nothing is submitted — you decide what
              happens next.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
