"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnswerStatusBadge } from "../../../components/answer-status-badge";
import { StatusRegion } from "../../../components/status-region";
import {
  pickRecorderMimeType,
  queueSpeech,
  recordedBlobToWav,
  voiceCaptureSupported,
} from "../../../lib/audio/capture";
import type { IntakeClientState } from "../../../lib/intake/serialize";

// The wizard fallback path — kept in step with the server's
// conversationErrorResponse payload (VAL-CONV-008). Defined locally: the
// conversation engine is server-only and must not enter the client bundle.
const WIZARD_FALLBACK_URL = "/intake";

// The conversational intake chat (Mission v2 M1 text, M2 voice). Talk or
// type — both flow through the same route and the same redaction. The
// transcript shows the REDACTED form of every user turn — the server
// replaces private values with "you told us" markers before they are stored
// or returned, so this screen keeps them private by construction (the mic
// hears it, the screen keeps it private). Assistant replies are subtitled
// in the transcript and spoken: Gemini audio when the server has a key,
// browser speechSynthesis otherwise. A model failure renders the honest
// error plus the wizard fallback link (VAL-CONV-007/008); a denied or
// missing microphone shows the typed path — never a dead end
// (VAL-VOICE-005).

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
  assistantTurnId: string;
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
  const [recording, setRecording] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  const [error, setError] = useState<{
    code: string;
    message: string;
    wizardFallbackUrl: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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

  // Capability probe: when the browser (or a headless context) has no mic
  // stack, surface the typed path immediately instead of on first click.
  // Deferred a microtask past hydration, and cleaned up on unmount.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setMicBlocked(!voiceCaptureSupported());
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function speakReply(turnId: string, subtitle: string): Promise<void> {
    // Spoken replies (VAL-VOICE-003): Gemini audio for the STORED reply
    // (the server speaks the turn by id — never client-supplied text)
    // when the server has a key, browser speechSynthesis otherwise. The
    // utterance is always the EXACT subtitle text shown in the transcript.
    try {
      const response = await fetch("/api/conversation/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId }),
      });
      if (response.ok) {
        const audio = new Audio(URL.createObjectURL(await response.blob()));
        audio.onended = () => URL.revokeObjectURL(audio.src);
        await audio.play();
        return;
      }
    } catch {
      // Fall through to the built-in voice.
    }
    try {
      queueSpeech(subtitle);
    } catch {
      // Speech is enhancement; the subtitle is the accessible path.
    }
  }

  async function handleTurnResponse(
    response: Response,
    spoken: boolean,
  ): Promise<void> {
    if (!response.ok) {
      const data = (await response.json()) as ConversationErrorResponse;
      setError({
        code: data.error?.code ?? "internal",
        message:
          data.error?.message ??
          "Something went wrong on our side. Please try again.",
        wizardFallbackUrl:
          data.error?.wizardFallbackUrl ?? WIZARD_FALLBACK_URL,
      });
      setNotice("The assistant could not reply just now.");
      return;
    }
    const data = (await response.json()) as TurnResponse;
    setTurns((previous) => [
      ...previous,
      {
        id: nextLocalTurnId(),
        role: "user",
        transcript: data.redactedUserTranscript,
      },
      { id: nextLocalTurnId(), role: "assistant", transcript: data.assistantReply },
    ]);
    setState(data.state);
    setDraft("");
    setNotice(
      data.nextQuestionId
        ? "The assistant asked the next question."
        : "All questions are answered.",
    );
    if (spoken) {
      void speakReply(data.assistantTurnId, data.assistantReply);
    }
  }

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
      await handleTurnResponse(response, false);
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

  async function submitVoiceTurn(recorded: Blob): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice("Processing your recording…");
    try {
      const wav = await recordedBlobToWav(recorded);
      const form = new FormData();
      form.append("audio", wav, "turn.wav");
      const response = await fetch("/api/conversation/turn", {
        method: "POST",
        body: form,
      });
      await handleTurnResponse(response, true);
    } catch {
      setNotice(
        "We couldn't process that recording. Please try again, or type your answer below.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startRecording(): Promise<void> {
    setError(null);
    setNotice("");
    if (!voiceCaptureSupported()) {
      setMicBlocked(true);
      setNotice(
        "Voice input isn't available in this browser. You can type your answers below — they work exactly the same way.",
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const recorded = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        chunksRef.current = [];
        void submitVoiceTurn(recorded);
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        setNotice(
          "Recording failed. You can type your answer below instead.",
        );
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setNotice("Listening… press Stop and send when you're done.");
    } catch {
      // Permission denied or device unavailable: the typed path is the
      // answer — visible guidance, never a dead end (VAL-VOICE-005).
      setMicBlocked(true);
      setNotice(
        "Your microphone isn't available. You can type your answers below — they work exactly the same way.",
      );
    }
  }

  function stopRecording(): void {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
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
          {micBlocked ? "Type your answer" : "Speak or type your answer"}
        </label>
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            data-voice-toggle
            aria-pressed={recording}
            onClick={() => {
              if (recording) {
                stopRecording();
              } else {
                void startRecording();
              }
            }}
            disabled={busy}
            className="flex shrink-0 items-center gap-2 rounded-md border border-zinc-300 px-4 py-2.5 text-base font-semibold hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
          >
            <span aria-hidden="true">{recording ? "■" : "●"}</span>
            {recording ? "Stop and send" : "Record an answer"}
          </button>
          <span className="self-center text-sm text-zinc-600 dark:text-zinc-400">
            {recording
              ? "Recording — speak now."
              : "Hold a short conversation with the assistant using your voice."}
          </span>
        </div>
        {micBlocked ? (
          <p
            data-mic-blocked-guidance
            className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            The microphone isn&apos;t available right now. The text box below
            works exactly the same way — typed answers save, redact, and
            continue the conversation identically.
          </p>
        ) : null}
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
