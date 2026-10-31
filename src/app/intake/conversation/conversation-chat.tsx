"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnswerStatusBadge } from "../../../components/answer-status-badge";
import { StatusRegion } from "../../../components/status-region";
import {
  queueSpeech,
  recordedBlobToWav,
  voiceCaptureSupported,
} from "../../../lib/audio/capture";
import {
  DEFAULT_ENDPOINTING,
} from "../../../lib/audio/endpointing";
import {
  createVoiceSession,
  type VoiceSession,
} from "../../../lib/audio/voice-session";
import {
  CONSENT_PATHS,
  attachConsentHeader,
  CONSENT_PROVIDER_ID,
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
import { ModeChoice, type ConversationEntryMode } from "./mode-choice";
import { PurgeSection } from "./purge-section";
import { ReviewSection } from "./review-section";

// The conversational intake chat (Mission v2 M1 text, M2 voice, M5 consent,
// and the HACK-106 natural-conversation rebuild). Two voice entry modes
// ONLY, chosen at a calm entry moment: (A) talk the whole way — one
// CONTINUOUS voice session, no per-question record/stop ritual, utterances
// end by silence endpointing; (B) talk with the switch-to-typing control
// available at ANY point, mid-session, without losing session state. Talk
// or type — both flow through the same route and the same redaction.
//
// CONSENT GATE (Mission v2.1 M5, HACK-81, VAL-CONSENT-*): nothing is sent
// anywhere before the user's per-device consent receipt allows it. The
// consent surface precedes the first send; the voice path sits behind its
// own additional toggle — with it off, the microphone is never started and
// no audio is transmitted; with consent declined, the deterministic
// spec-driven wizard drives the SAME journey on this page with zero API
// calls carrying user content. HONEST FRAMING: with sharing on, the
// extraction step sees the raw typed or spoken sentence before anything is
// hidden — the consent copy discloses that send rather than pretending it
// does not happen. The receipt lives in the user's localStorage (no answer
// data attached), is shown in the privacy-choices panel, and revoking
// stops further sends immediately (every send re-checks it; the server
// re-checks too, and revoking mid-voice-session stops the microphone).

const WIZARD_FALLBACK_URL = "/intake";

export type VoiceInterimPhase =
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

/**
 * The instant perceived-latency states (VAL-VLAT-001), rendered as the
 * conversation stage's state bar (VAL-VJS-002, per the approved Lovable
 * round-2 frames): "listening" renders the moment recording starts,
 * "transcribing" the moment it stops — synchronously with the endpoint,
 * far inside the 500 ms budget — "thinking" refines the same in-flight
 * window once the wait is long enough that "your subtitles are coming
 * together" is no longer the whole truth, and "speaking" covers the
 * reply playback. A null phase renders nothing. Deliberately NOT a live
 * region: the notice (StatusRegion) announces the same phases, and a
 * second live region would make screen readers announce them twice.
 */
export function VoiceInterimState({
  phase,
}: {
  phase: VoiceInterimPhase | null;
}) {
  if (phase === null) {
    return null;
  }
  return (
    <p
      data-voice-interim-state={phase}
      data-voice-state-bar
      className="text-sm font-medium text-muted"
    >
      {phase === "listening"
        ? "Listening — go ahead, we're right here."
        : phase === "transcribing"
          ? "Transcribing — your subtitles are coming together."
          : phase === "thinking"
            ? "Thinking — taking a moment with what you shared."
            : "Speaking — your reply is here to read, too."}
    </p>
  );
}

interface ConversationTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly transcript: string;
}

/**
 * The state bar's "thinking" refinement (VAL-VJS-002, per the frames):
 * one POST carries STT + extraction + reply, so the in-flight window
 * starts as "transcribing"; once the wait is long enough that "your
 * subtitles are coming together" is no longer the whole truth, the
 * caption honestly renames the same window. A pure seam so the mapping
 * (and that it never touches any other phase) is unit-testable; the
 * timer that applies it is a one-liner beside the 5 s escalate notice
 * (which follows the same untested-timer precedent).
 */
export function refineThinkingPhase(
  current: VoiceInterimPhase | null,
): VoiceInterimPhase | null {
  return current === "transcribing" ? "thinking" : current;
}

/**
 * The short wrap-up spoken when the deterministic engine has no
 * unanswered question left (VAL-VJS-003), and the visible handoff line
 * at the top of the results stage (VAL-VJS-004). One text for both so
 * the spoken words are exactly the words on screen. Permitted framing
 * only — "may be worth pursuing", the person reviews/signs/submits —
 * never an eligibility or approval claim.
 */
export const RESULTS_WRAP_UP =
  "That's everything I need. Based on what you shared, here's what may " +
  "be worth pursuing — with the official sources — and your filled " +
  "application form to review, sign, and submit yourself.";

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
  // The interim perceived-latency phase (VAL-VLAT-001): "listening" while
  // the session's mic is open, "transcribing" from the instant an
  // utterance ends until the turn response lands, "speaking" while the
  // reply plays, null otherwise.
  const [voicePhase, setVoicePhase] = useState<VoiceInterimPhase | null>(null);
  // Fallback honesty (VAL-TTS2-002): when the server-side voice (ElevenLabs)
  // fails and the built-in browser voice covers the reply instead, the UI
  // says so — silent degradation to the OS voice is the exact bug that
  // caused the ElevenLabs switch (HACK-116).
  const [builtInVoiceFallback, setBuiltInVoiceFallback] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  // The two entry modes (VAL-NCF-002): the entry choice is a moment, the
  // session state follows it. entryMode null = the choice hasn't been
  // made yet (the choice card shows); paused = the session is holding.
  const [entryMode, setEntryMode] = useState<ConversationEntryMode | null>(
    null,
  );
  const [sessionOn, setSessionOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [typingMode, setTypingMode] = useState(false);
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
  // The continuous voice session (HACK-106): all mic/recorder/endpointing
  // wiring lives behind ONE stable ref — the component only maps session
  // events to UI state and submits the utterances.
  const sessionRef = useRef<VoiceSession | null>(null);
  // The session's onUtterance callback is captured once at begin(); routing
  // it through a latest-ref keeps every utterance running with THIS
  // render's submit function — the busy guard, the consent re-check, and
  // the receipt header always read the current values (claude-review P2:
  // no stale closure across a long-lived session).
  const submitVoiceTurnRef = useRef<((blob: Blob) => Promise<void>) | null>(
    null,
  );

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

  // The three-stage voice journey (VAL-VJS-001..004), derived — no extra
  // state machine to desync. A voice-consented visitor (AI + voice on,
  // panel closed, not the zero-send path) moves ENTRY (the mode choice,
  // VAL-VJS-001) → TALK (the clean transcript stage, VAL-VJS-002) →
  // RESULTS the moment the deterministic engine reports no unanswered
  // question left (state.complete — the auto-advance, VAL-VJS-003).
  // Every non-voice path (consent panel open, zero-send, ai-only typed)
  // keeps today's single-scroll layout untouched.
  const voiceConsented =
    !panelOpen && !zeroSend && aiSharingOn && voiceSharingOn;
  const journeyComplete = state?.complete ?? false;
  const resultsStage = voiceConsented && journeyComplete;
  const entryStage = voiceConsented && entryMode === null && !journeyComplete;
  const talkStage = voiceConsented && entryMode !== null && !journeyComplete;

  // Surface conditions (the two-mode rule, VAL-NCF-002): mode A shows no
  // typing at all; mode B offers the switch at any point; the typed form
  // carries the ai-only, switched, and mic-fallback cases.
  const voiceSessionSurface = talkStage && sessionOn && !typingMode;
  const typedSurface =
    !panelOpen &&
    !zeroSend &&
    aiSharingOn &&
    !resultsStage &&
    (!voiceSharingOn || typingMode || micBlocked);

  // Revoking voice consent mid-session stops the microphone immediately
  // and lands the person in the typed conversation (never a dead end).
  useEffect(() => {
    if (!voiceSharingOn && sessionRef.current !== null) {
      sessionRef.current.stop();
      sessionRef.current = null;
      setSessionOn(false);
      setPaused(false);
      setTypingMode(true);
      setNotice(
        "Voice sharing turned off, so the microphone is off. Type below — it works exactly the same way.",
      );
    }
  }, [voiceSharingOn]);

  // The journey is complete (VAL-VJS-003): the voice session ends with
  // it — no further listening once the results stage renders. Covers both
  // the live final turn and a reload onto an already-complete session.
  useEffect(() => {
    if (journeyComplete && sessionRef.current !== null) {
      sessionRef.current.stop();
      sessionRef.current = null;
      setSessionOn(false);
      setPaused(false);
    }
  }, [journeyComplete]);

  // Full teardown on unmount: no orphaned mic or audio context.
  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  // While the privacy-choice surface is open, the voice session HOLDS (the
  // mic stops listening; nothing is captured while the person is deciding
  // about their privacy). The session resumes only when they press Resume.
  useEffect(() => {
    if (panelOpen && sessionRef.current !== null) {
      sessionRef.current.hold();
      setPaused(true);
    }
  }, [panelOpen]);

  function decideConsent(): void {
    const next: ConsentReceipt = {
      v: 2,
      providerId: CONSENT_PROVIDER_ID,
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
    // Spoken replies (VAL-VOICE-003): ElevenLabs audio for the STORED reply
    // (the server speaks the turn by id — never client-supplied text)
    // when voice sharing is ON, browser speechSynthesis otherwise. With
    // voice sharing off the speak route is never called — reply audio is
    // made locally or not at all (VAL-CONSENT-003). The utterance is
    // always the EXACT subtitle text shown in the transcript. The
    // promise resolves when playback finishes (or fails), so the
    // continuous session's next listening cycle never transcribes the
    // assistant's own voice.
    if (voiceSharingOn) {
      let providerFailed = false;
      try {
        const response = await fetch("/api/conversation/speak", {
          method: "POST",
          headers: attachConsentHeader(
            new Headers({ "content-type": "application/json" }),
          ),
          body: JSON.stringify({ turnId }),
        });
        if (!response.ok) {
          // The provider call failed (down, rate-limited, unconfigured):
          // the built-in voice covers below — VISIBLY (VAL-TTS2-002),
          // never a silent degradation to the OS voice again.
          providerFailed = true;
        } else {
          setBuiltInVoiceFallback(false);
          try {
            const audio = new Audio(
              URL.createObjectURL(await response.blob()),
            );
            await new Promise<void>((resolve) => {
              audio.onended = () => {
                URL.revokeObjectURL(audio.src);
                resolve();
              };
              audio.onerror = () => {
                URL.revokeObjectURL(audio.src);
                resolve();
              };
              audio.play().catch(() => resolve());
            });
            return;
          } catch {
            // Local playback failed after a SUCCESSFUL provider call —
            // speech is enhancement (the subtitle is the accessible
            // path), and this is not a provider failure: no badge.
          }
        }
      } catch {
        // The speak route itself was unreachable: a provider failure.
        providerFailed = true;
      }
      if (providerFailed) {
        setBuiltInVoiceFallback(true);
      }
    }
    try {
      await new Promise<void>((resolve) => {
        const spoke = queueSpeech(subtitle, undefined, resolve);
        if (!spoke) {
          resolve();
        }
      });
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
    const wasComplete = state?.complete ?? false;
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
        : "Your conversation is complete. Your results are ready.",
    );
    if (spoken && voiceSharingOn) {
      setVoicePhase("speaking");
      await speakReply(data.assistantTurnId, data.assistantReply);
    }
    // The auto-advance (VAL-VJS-003): when the deterministic engine has no
    // unanswered question left, speak the short wrap-up and hand off to
    // the results stage — no additional form clicks (the results render
    // from state.complete itself). The wrap-up speaks locally (no send):
    // it is UI copy, not an assistant turn, so the speak route — which
    // speaks stored turns by id — is not involved. Gated on the VOICE
    // journey: an ai-only typed completion never hears audio (and its
    // layout is the single-scroll one, not the results stage).
    if (data.state.complete && !wasComplete && voiceSharingOn && entryMode !== null) {
      queueSpeech(RESULTS_WRAP_UP);
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

  // Latest-ref wiring (see the ref's comment): the session callback reads
  // the CURRENT submit function on every utterance. An effect, not a
  // render-time write: the session delivers an utterance only after real
  // speech + silence (≥ seconds), never inside the commit-to-effect gap.
  useEffect(() => {
    submitVoiceTurnRef.current = submitVoiceTurn;
  });

  // The continuous voice session (VAL-NCF-001): the mic opens ONCE per
  // session; each utterance is one recorder cycle ended by silence
  // endpointing (or the hard cap). No per-question record/stop ritual —
  // the person just talks.

  function restartListeningIfActive(): void {
    // The session object no-ops when it is stopped or paused; the call is
    // always safe.
    sessionRef.current?.listen();
  }

  async function submitVoiceTurn(recorded: Blob): Promise<void> {
    if (busy) {
      setVoicePhase(null);
      restartListeningIfActive();
      return;
    }
    setBusy(true);
    setError(null);
    setNotice("Transcribing your recording…");
    // The state bar's "thinking" refinement (VAL-VJS-002, per the
    // frames): see refineThinkingPhase above.
    const think = setTimeout(() => {
      setVoicePhase(refineThinkingPhase);
    }, 4000);
    // If the turn is still pending after 5 s, escalate the wait message —
    // honestly (no phase claim), so a slow turn never reads as a hang.
    const escalate = setTimeout(() => {
      setNotice("Still working on your recording — thanks for waiting.");
    }, 5000);
    try {
      const response = await sendVoiceTurn(recorded);
      await handleTurnResponse(response, true);
    } catch {
      setNotice(
        "We couldn't process that recording. Please try again, or type your answer below.",
      );
    } finally {
      clearTimeout(think);
      clearTimeout(escalate);
      setVoicePhase(null);
      setBusy(false);
      // The session breathes again: the next listening cycle starts once
      // the reply has finished playing (or the turn failed honestly).
      restartListeningIfActive();
    }
  }
  // Latest-ref wiring (see the ref's comment): the session callback reads
  // the CURRENT submit function on every utterance. An effect, not a
  // render-time write: the session delivers an utterance only after real
  // speech + silence (≥ seconds), never inside the commit-to-effect gap.
  useEffect(() => {
    submitVoiceTurnRef.current = submitVoiceTurn;
  });

  async function beginVoiceSession(
    mode: ConversationEntryMode,
  ): Promise<void> {
    // The consent gate for voice (VAL-CONSENT-003): with voice sharing
    // off, the microphone is NEVER started and no audio is transmitted.
    if (!consentPathEnabled("voice", receipt)) {
      setReopened(true);
      setNotice(
        "Voice sharing is off, so recording is off. Turn on voice sharing, or type your answer below — it works exactly the same way.",
      );
      return;
    }
    if (!voiceCaptureSupported()) {
      setMicBlocked(true);
      setEntryMode(mode);
      setNotice(
        "Voice input isn't available in this browser. You can type your answers below — they work exactly the same way.",
      );
      return;
    }
    const session = createVoiceSession(
      {
        onUtterance: (blob) => void submitVoiceTurnRef.current?.(blob),
        onPhase: (phase) => setVoicePhase(phase),
        onRecorderError: () => {
          // A mid-session recorder failure ends the session and lands the
          // person in the typed conversation (never a dead end, even in
          // the voice-only mode — the typed form is the mic fallback).
          // stop() releases the mic stream and audio context (claude-review
          // P2: no orphaned hardware while the UI says to type).
          sessionRef.current?.stop();
          sessionRef.current = null;
          setSessionOn(false);
          setMicBlocked(true);
          setNotice(
            "Recording failed. You can type your answer below instead.",
          );
        },
      },
      DEFAULT_ENDPOINTING,
    );
    try {
      await session.begin();
      sessionRef.current = session;
      setEntryMode(mode);
      setSessionOn(true);
      setPaused(false);
      setTypingMode(false);
    } catch {
      // Permission denied or device unavailable: the typed path is the
      // answer — visible guidance, never a dead end (VAL-VOICE-005).
      setMicBlocked(true);
      setEntryMode(mode);
      setNotice(
        "Your microphone isn't available. You can type your answers below — they work exactly the same way.",
      );
    }
  }

  function holdSession(): void {
    // Pause: stop listening and DISCARD any in-flight utterance (a person
    // pausing doesn't expect a half-thought to send). The session keeps
    // the mic stream for a quick resume.
    sessionRef.current?.hold();
    setPaused(true);
    setVoicePhase(null);
    setNotice("Paused — ready whenever you are.");
  }

  function resumeSession(): void {
    setPaused(false);
    setNotice("");
    sessionRef.current?.resume();
  }

  function stopSession(): void {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setSessionOn(false);
    setPaused(false);
    setVoicePhase(null);
  }

  function switchToTyping(): void {
    // The mode-B exit (VAL-NCF-002): works at ANY point — mid-utterance
    // included — and nothing is lost: the transcript, answers, and session
    // identity all stay exactly as they were.
    stopSession();
    setTypingMode(true);
    setNotice("Same conversation. Nothing lost. Type your answer below.");
  }

  function switchBackToVoice(): void {
    setTypingMode(false);
    void beginVoiceSession(entryMode ?? "voice-plus-typing");
  }

  // The purge's client half (HACK-80): the server rows are gone (the purge
  // route's transaction committed), so empty the local transcript and
  // re-read the journey from the server — which now returns the empty
  // state. Resume/reload from here on shows the empty journey, because the
  // data truly no longer exists.
  function purgeClientState(): void {
    setTurns([]);
    setAnswersRefresh((n) => n + 1);
  }

  const answeredQuestions = state
    ? state.questions.filter((question) => state.answers[question.id])
    : [];

  // The journey sections, reused intact (VAL-VJS-004): answers-so-far +
  // the match engine's framing card + the review/download handoff + the
  // purge. The results stage hosts them; every non-voice path keeps them
  // inline exactly as before the restage. Reusing the components keeps
  // the gate-gated copy and provenance rendering word-identical.
  const journeySections = state ? (
    <>
      <section
        data-answers-so-far
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

      <MatchSection refreshKey={turns.length + answersRefresh} />
      <ReviewSection refreshKey={turns.length + answersRefresh} />
      <PurgeSection onPurged={purgeClientState} />
    </>
  ) : null;

  // Surface conditions live with the consent gates above (the three-stage
  // derivation must precede the effects that read it).

  return (
    <div
      data-conversation-chat
      data-entry-mode={entryMode ?? undefined}
      data-journey-stage={
        resultsStage ? "results" : talkStage ? "talk" : entryStage ? "entry" : undefined
      }
      className="flex flex-col gap-6"
    >
      <p className="text-sm text-muted">
        Prefer step-by-step questions?{" "}
        <Link
          href={WIZARD_FALLBACK_URL}
          className="underline hover:text-foreground"
        >
          Use the wizard instead
        </Link>
        . It keeps answers only on this device and doesn&apos;t see what you
        tell the chat.
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

      {/* The transcript lives on the TALK stage (VAL-VJS-002). The entry
      stage is the clean mode-choice screen and the results stage replaces
      the conversation with the handoff — per the approved frames. */}
      {!entryStage && !resultsStage ? (
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
      ) : null}

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

      {entryStage ? (
        <ModeChoice onBegin={(mode) => void beginVoiceSession(mode)} />
      ) : null}

      {voiceSessionSurface ? (
        <div
          data-voice-session={paused ? "paused" : "active"}
          className="flex flex-col gap-2"
        >
          <VoiceInterimState phase={voicePhase} />
          {builtInVoiceFallback ? (
            <p
              data-voice-fallback-badge
              className="self-start rounded-full border border-amber-ink px-3 py-1 text-sm font-medium text-amber-ink"
            >
              Hearing the built-in voice — the assistant&apos;s usual voice is
              unavailable right now.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {paused ? (
              <button
                type="button"
                data-voice-resume
                onClick={resumeSession}
                // A resume while a turn is in flight would start a second
                // recorder cycle alongside the turn's own (claude-review
                // P2): resume waits for the turn to settle.
                disabled={busy}
                className="min-h-12 flex shrink-0 items-center gap-2 rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:cursor-not-allowed disabled:opacity-60"
              >
                Resume listening
              </button>
            ) : (
              <button
                type="button"
                data-voice-pause
                onClick={holdSession}
                disabled={busy}
                className="min-h-12 flex shrink-0 items-center gap-2 rounded-full border border-teal px-6 py-2.5 text-base font-semibold text-teal hover:bg-teal-soft disabled:opacity-50"
              >
                Pause
              </button>
            )}
            {entryMode === "voice-plus-typing" ? (
              <button
                type="button"
                data-switch-to-typing
                onClick={switchToTyping}
                className="min-h-12 flex shrink-0 items-center gap-2 rounded-full border border-teal bg-surface px-6 py-2.5 text-base font-semibold text-teal hover:bg-teal-soft"
              >
                Switch to typing
              </button>
            ) : null}
            <span className="text-sm text-muted">
              {paused
                ? "Paused."
                : entryMode === "voice-only"
                  ? "Speak freely — the assistant hears when you finish a thought."
                  : "Speak freely; switch to typing whenever you like."}
            </span>
          </div>
        </div>
      ) : null}

      {typedSurface ? (
      <form
        data-typing-mode={typingMode || undefined}
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submitTurn();
        }}
      >
        {typingMode ? (
          <p
            data-typing-caption
            className="rounded-xl border border-teal/25 bg-teal-soft p-3 text-sm text-muted"
          >
            Same conversation. Nothing lost. Everything you said is right
            here, and spoken replies stop until you turn the voice back on.
          </p>
        ) : null}
        {entryMode === "voice-plus-typing" && typingMode && !micBlocked ? (
          <button
            type="button"
            data-switch-to-voice
            onClick={switchBackToVoice}
            className="self-start rounded-full border border-teal px-6 py-2.5 text-base font-semibold text-teal hover:bg-teal-soft"
          >
            Use your voice instead
          </button>
        ) : null}
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
          className="rounded-2xl border border-surface-border bg-surface p-3.5 text-base"
        />
        <p id="conversation-input-help" className="text-sm text-muted">
          Private details stay private: the transcript below shows them only as
          &ldquo;you told us&rdquo; marks, never the values themselves.
        </p>
        <button
          type="submit"
          disabled={busy || draft.trim() === ""}
          className="min-h-12 self-start rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
      ) : null}

      {!voiceSharingOn && aiSharingOn && !panelOpen && !resultsStage ? (
        <p
          data-voice-consent-guidance
          className="rounded-xl border border-teal/25 bg-teal-soft p-3 text-sm text-muted"
        >
          Voice sharing is off, so the microphone is never started and no
          audio is ever transmitted. You can turn it on under
          &ldquo;Your privacy choices&rdquo;, or just type above.
        </p>
      ) : null}
      {micBlocked && !panelOpen && aiSharingOn && !resultsStage ? (
        <p
          data-mic-blocked-guidance
          className="rounded-xl border border-teal/25 bg-teal-soft p-3 text-sm text-muted"
        >
          The microphone isn&apos;t available right now. The text box above
          works exactly the same way — typed answers save, redact, and
          continue the conversation identically.
        </p>
      ) : null}

      {receipt !== null && !panelOpen ? (
        <ConsentReceiptPanel
          receipt={receipt}
          onRevoke={revokeConsent}
          onReopen={reopenConsent}
        />
      ) : null}

      {resultsStage ? (
        <section
          data-results-stage
          aria-labelledby="results-stage-heading"
          className="flex flex-col gap-6"
        >
          <div className="flex flex-col gap-2">
            <h2 id="results-stage-heading" className="font-display text-2xl font-bold">
              Your results
            </h2>
            <p data-results-wrap-up className="max-w-xl text-muted">
              {RESULTS_WRAP_UP}
            </p>
          </div>
          {journeySections}
        </section>
      ) : !voiceConsented ? (
        journeySections
      ) : null}

      {/* Purge stays reachable at EVERY point of the voice journey
      (VAL-VJS-003): on the entry and talk stages the full journey
      sections stay off-stage, so the purge section renders on its own
      here — the results stage and the non-voice paths render it inside
      journeySections above. */}
      {voiceConsented && !resultsStage && state ? (
        <PurgeSection onPurged={purgeClientState} />
      ) : null}
    </div>
  );
}
