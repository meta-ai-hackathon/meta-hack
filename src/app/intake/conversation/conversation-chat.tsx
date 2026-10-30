"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnswerStatusBadge } from "../../../components/answer-status-badge";
import { StatusRegion } from "../../../components/status-region";
import {
  pickRecorderMimeType,
  queueSpeech,
  recordedBlobToWav,
  voiceCaptureSupported,
} from "../../../lib/audio/capture";
import {
  CONSENT_PATHS,
  attachConsentHeader,
  cachedConsentSnapshot,
  clearConsentReceipt,
  consentPathEnabled,
  declinedReceipt,
  saveConsentReceipt,
  subscribeToConsentChanges,
  type ConsentReceipt,
} from "../../../lib/consent";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import { IntakeWizard } from "../intake-wizard";
import { ConsentPanel, ConsentReceiptPanel } from "./consent-surface";
import { MatchSection } from "./match-section";
import { ReviewSection } from "./review-section";

// The wizard fallback path — kept in step with the server's
// conversationErrorResponse payload (VAL-CONV-008). Defined locally: the
// conversation engine is server-only and must not enter the client bundle.
const WIZARD_FALLBACK_URL = "/intake";

// The conversational intake chat (Mission v2 M1 text, M2 voice, M5 consent).
// Talk or type — both flow through the same route and the same redaction.
//
// CONSENT GATE (Mission v2.1 M5, HACK-81, VAL-CONSENT-*): nothing is sent
// anywhere before the user's per-device consent receipt allows it. The
// consent surface precedes the first send; the voice path sits behind its
// own additional toggle — with it off, the microphone is never started and
// no audio is transmitted; with consent declined, the deterministic
// spec-driven wizard drives the SAME journey on this page with zero API
// calls carrying user content (the server independently refuses every send
// without a receipt). HONEST FRAMING: with sharing on, the extraction step
// sees the raw typed sentence before anything is hidden — the consent copy
// discloses that send rather than pretending it does not happen. The
// receipt lives in the user's localStorage (no answer data attached), is
// shown in the privacy-choices panel, and revoking stops further sends
// immediately (every send re-checks it; the server re-checks too).

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

/**
 * The voice send (VAL-CONSENT-006): the recorded blob is transcoded to the
 * Meta-accepted WAV and POSTed as multipart to the same turn route the
 * typed path uses — WITH the consent header attached, exactly as the typed
 * and speak paths attach theirs (the server refuses every voice turn
 * without it, and a 403 then wipes the receipt). No manual content-type:
 * the browser's multipart boundary must describe the FormData body.
 * fetchImpl is injectable so the client wiring is unit-testable (the same
 * seam idiom as pickRecorderMimeType/queueSpeech).
 */
export async function sendVoiceTurn(
  recorded: Blob,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const wav = await recordedBlobToWav(recorded);
  const form = new FormData();
  form.append("audio", wav, "turn.wav");
  return fetchImpl("/api/conversation/turn", {
    method: "POST",
    headers: attachConsentHeader(new Headers()),
    body: form,
  });
}

export function ConversationChat() {
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [state, setState] = useState<IntakeClientState | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  // Consent state (VAL-CONSENT-*): the receipt is an EXTERNAL store —
  // this device's localStorage, subscribed via useSyncExternalStore (SSR
  // renders the server snapshot: no receipt, surface open, sends off —
  // the honest first paint). Revoking in another tab stops sends here too.
  const storedReceipt = useSyncExternalStore(
    subscribeToConsentChanges,
    cachedConsentSnapshot,
    () => null,
  );
  const [reopened, setReopened] = useState(false);
  const [draftAi, setDraftAi] = useState(false);
  const [draftVoice, setDraftVoice] = useState(false);
  // Bumped by the deterministic wizard after each save, so match/review
  // re-read the stored answers in zero-send mode (no conversation turns
  // happen to trigger their refreshKey otherwise).
  const [answersRefresh, setAnswersRefresh] = useState(0);
  const receipt = storedReceipt;
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

  // The consent surface is open when no decided receipt exists (nothing
  // sent yet) or the user asked to change the choices. Derived — no effect.
  const panelOpen = receipt === null || reopened;

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

  // Zero-send mode has no conversation turns to bump the match/review
  // refresh key: the deterministic wizard's saves re-read the stored state
  // instead (a GET of the caller's own session — no provider send involved).
  useEffect(() => {
    if (answersRefresh === 0) {
      return;
    }
    let cancelled = false;
    fetch("/api/conversation/history")
      .then(async (response) => {
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as HistoryResponse;
        if (!cancelled) {
          setTurns(data.turns);
          setState(data.state);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [answersRefresh]);

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

  // Consent-derived gates (re-checked at EVERY send, so revoking stops
  // further sends immediately).
  const aiSharingOn = consentPathEnabled("ai-conversation", receipt);
  const voiceSharingOn = consentPathEnabled("voice", receipt);
  const sharingDeclined = receipt !== null && !receipt.ai;
  const zeroSend = sharingDeclined && !panelOpen;

  function decideConsent(): void {
    const next: ConsentReceipt = {
      v: 1,
      ai: draftAi,
      voice: draftAi && draftVoice,
      at: new Date().toISOString(),
    };
    saveConsentReceipt(next);
    setReopened(false);
    setNotice(
      next.ai
        ? next.voice
          ? "Sharing on, including voice. Nothing has been sent to any AI provider yet."
          : "Sharing on for typed answers. Nothing has been sent to any AI provider yet."
        : "Sharing is off. Nothing goes to any AI provider.",
    );
  }

  function declineConsent(): void {
    saveConsentReceipt(declinedReceipt());
    setReopened(false);
    setNotice("Sharing is off. Nothing goes to any AI provider.");
  }

  function revokeConsent(): void {
    saveConsentReceipt(declinedReceipt());
    setReopened(false);
    setNotice("Sharing is off. Nothing more will be sent to any AI provider.");
  }

  function reopenConsent(): void {
    setDraftAi(receipt?.ai ?? false);
    setDraftVoice(receipt?.voice ?? false);
    setReopened(true);
  }

  async function speakReply(turnId: string, subtitle: string): Promise<void> {
    // Spoken replies (VAL-VOICE-003): Gemini audio for the STORED reply
    // (the server speaks the turn by id — never client-supplied text)
    // when voice sharing is ON, browser speechSynthesis otherwise. With
    // voice sharing off the speak route is never called — reply audio is
    // made locally or not at all (VAL-CONSENT-003). The utterance is
    // always the EXACT subtitle text shown in the transcript.
    if (voiceSharingOn) {
      try {
        const response = await fetch("/api/conversation/speak", {
          method: "POST",
          headers: attachConsentHeader(
            new Headers({ "content-type": "application/json" }),
          ),
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
      if (data.error?.code === "consent_required") {
        // Out of sync (e.g. the receipt was revoked in another tab):
        // nothing was sent — drop the local receipt so the choice surface
        // re-opens, fail closed.
        clearConsentReceipt();
        setReopened(false);
        setNotice(
          "Your sharing choice was missing, so nothing was sent. Choose again to continue.",
        );
        return;
      }
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
    if (spoken && voiceSharingOn) {
      void speakReply(data.assistantTurnId, data.assistantReply);
    }
  }

  async function submitTurn(): Promise<void> {
    const text = draft.trim();
    if (text === "" || busy) {
      return;
    }
    // The consent gate, at send time (VAL-CONSENT-001/002): no typed words
    // leave the device unless the receipt allows it. The server checks the
    // same receipt again.
    if (!consentPathEnabled("ai-conversation", receipt)) {
      setReopened(true);
      setNotice(
        "Choose your sharing setting first — nothing is sent without it.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const response = await fetch("/api/conversation/turn", {
        method: "POST",
        headers: attachConsentHeader(
          new Headers({ "content-type": "application/json" }),
        ),
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
      const response = await sendVoiceTurn(recorded);
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
    // The consent gate for voice (VAL-CONSENT-003): with voice sharing off,
    // the microphone is NEVER started and no audio is transmitted. The
    // record button is disabled too — this is the belt to its braces.
    if (!consentPathEnabled("voice", receipt)) {
      setReopened(true);
      setNotice(
        "Voice sharing is off, so recording is off. Turn on voice sharing, or type your answer below — it works exactly the same way.",
      );
      return;
    }
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
      <p className="text-sm text-muted">
        Prefer step-by-step questions?{" "}
        <Link
          href={WIZARD_FALLBACK_URL}
          className="underline hover:text-foreground"
        >
          Use the wizard instead
        </Link>
      </p>

      {panelOpen ? (
        <ConsentPanel
          aiChecked={draftAi}
          voiceChecked={draftVoice}
          paths={CONSENT_PATHS}
          onToggleAi={setDraftAi}
          onToggleVoice={setDraftVoice}
          onDecide={decideConsent}
          onDecline={declineConsent}
        />
      ) : null}

      {zeroSend ? (
        <section
          data-zero-send-mode
          aria-labelledby="zero-send-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="zero-send-heading" className="font-display text-2xl font-bold">
            Nothing goes to any AI provider
          </h2>
          <p className="max-w-xl text-muted">
            Sharing is off. The step-by-step questions below drive the same
            application right here — with honest status labels, your benefit
            match, the review screen, and the filled PDF to download when you
            are ready. Your answers save on the app&apos;s server so you can
            pick up later; no AI provider receives any of it.
          </p>
          <IntakeWizard onAnswersChanged={() => setAnswersRefresh((n) => n + 1)} />
        </section>
      ) : null}

      <StatusRegion message={notice} />

      <section aria-labelledby="conversation-transcript-heading" className="flex flex-col gap-3">
        <h2 id="conversation-transcript-heading" className="font-display text-2xl font-bold">
          Conversation
        </h2>
        {loaded && turns.length === 0 ? (
          <p className="max-w-xl text-muted">
            Say hello, or answer the first question whenever you are ready.
          </p>
        ) : null}
        <ul className="flex flex-col gap-3" data-conversation-transcript>
          {turns.map((turn) => (
            <li
              key={turn.id}
              className={
                turn.role === "user"
                  ? "self-end max-w-[85%] rounded-3xl rounded-br-lg bg-foreground px-4 py-2.5 text-background"
                  : "self-start max-w-[85%] rounded-3xl rounded-bl-lg border border-surface-border bg-surface px-4 py-2.5"
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
          className="flex flex-col gap-2 rounded-2xl border border-amber-line bg-amber-soft p-4 text-foreground"
        >
          <p className="font-medium">{error.message}</p>
          {error.code === "model_unavailable" || error.code === "rate_limited" ? (
            <p>
              You can answer step by step instead. That form keeps answers
              only on this device, so it doesn&apos;t see what you told the
              chat:{" "}
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

      {zeroSend ? null : (
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submitTurn();
        }}
      >
        <label htmlFor="conversation-input" className="font-medium">
          {micBlocked || !voiceSharingOn
            ? "Type your answer"
            : "Speak or type your answer"}
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
            disabled={busy || !voiceSharingOn}
            className="flex shrink-0 items-center gap-2 rounded-full border border-teal px-4 py-2.5 text-base font-semibold text-teal hover:bg-teal-soft disabled:opacity-50"
          >
            <span aria-hidden="true">{recording ? "■" : "●"}</span>
            {recording ? "Stop and send" : "Record an answer"}
          </button>
          <span className="self-center text-sm text-muted">
            {recording
              ? "Recording — speak now."
              : voiceSharingOn
                ? "Hold a short conversation with the assistant using your voice."
                : "Voice sharing is off, so the microphone is never used."}
          </span>
        </div>
        {!voiceSharingOn ? (
          <p
            data-voice-consent-guidance
            className="rounded-xl border border-teal/25 bg-teal-soft p-3 text-sm text-muted"
          >
            Voice sharing is off, so the microphone is never started and no
            audio is ever transmitted. You can turn it on under
            &ldquo;Your privacy choices&rdquo;, or just type below.
          </p>
        ) : null}
        {micBlocked ? (
          <p
            data-mic-blocked-guidance
            className="rounded-xl border border-teal/25 bg-teal-soft p-3 text-sm text-muted"
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
          disabled={busy || !aiSharingOn}
          aria-describedby="conversation-input-help"
          className="rounded-2xl border border-surface-border bg-surface p-3.5 text-base"
        />
        <p id="conversation-input-help" className="text-sm text-muted">
          Private details stay private: the transcript below shows them only as
          &ldquo;you told us&rdquo; marks, never the values themselves.
        </p>
        <button
          type="submit"
          disabled={busy || !aiSharingOn || draft.trim() === ""}
          className="self-start rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
      )}

      {receipt !== null && !panelOpen ? (
        <ConsentReceiptPanel
          receipt={receipt}
          onRevoke={revokeConsent}
          onReopen={reopenConsent}
        />
      ) : null}

      {state ? (
        <section
          aria-labelledby="conversation-status-heading"
          className="flex flex-col gap-2"
        >
          <h2 id="conversation-status-heading" className="font-display text-2xl font-bold">
            Your answers so far
          </h2>
          <p
            id="conversation-progress-text"
            className="text-sm text-muted"
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
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-surface-border bg-surface p-3"
                  >
                    <span className="font-medium">{question.prompt}</span>
                    {answer ? <AnswerStatusBadge status={answer.status} /> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {state.complete ? (
            <p className="text-muted">
              Every question is answered. Nothing is submitted — you decide what
              happens next.
            </p>
          ) : null}
        </section>
      ) : null}

      {state ? (
        <MatchSection refreshKey={turns.length + answersRefresh} />
      ) : null}
      {state ? (
        <ReviewSection refreshKey={turns.length + answersRefresh} />
      ) : null}
    </div>
  );
}
