"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnswerStatusBadge } from "../../../components/answer-status-badge";
import { StatusRegion } from "../../../components/status-region";
import {
  queueSpeech,
  recordedBlobToWav,
  voiceCaptureSupported,
} from "../../../lib/audio/capture";
import {
  DEFAULT_ENDPOINTING,
  type EndpointTiming,
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
import { takeStoredEntryMode } from "../../../lib/entry-mode";
import { IntakeWizard } from "../intake-wizard";
import { ComingTogether, themesForQuestionIds, themeLabelFor } from "./coming-together";
import { ConsentPanel, ConsentReceiptPanel } from "./consent-surface";
import { IncomeStage } from "./income-stage";
import { MatchSection } from "./match-section";
import { ModeChoice, type ConversationEntryMode } from "./mode-choice";
import { PurgeSection } from "./purge-section";
import { PresenceOrb } from "./presence-orb";
import { QuickQuestionsStage } from "./quick-questions";
import { ReviewSection } from "./review-section";
import { STAGE_GRID_CLASS } from "./stage-grid";
import { PauseIcon, PlayIcon, VoiceDeck } from "./voice-deck";

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

/**
 * The bounded continuation queue (VAL-FIX-001): how many utterances may
 * wait while one turn processes. Generous for real speech (a turn lasts
 * seconds; people finish one thought at a time), small enough that
 * runaway noise can never chain unlimited model turns. Overflow is
 * dropped with an honest notice, never silently.
 */
export const MAX_PENDING_VOICE_TURNS = 3;

/**
 * The transcript pane's stick threshold (VAL-FIX-002): how close to the
 * pane's bottom, in px, still counts as "parked at the latest turn". Small
 * enough that an intentional scroll up is always honored (no yanking),
 * large enough to absorb a few px of reflow.
 */
export const TRANSCRIPT_STICK_THRESHOLD_PX = 32;

/**
 * Whether the transcript pane is parked at its latest turn (VAL-FIX-002).
 * Pure and exported for tests: auto-scroll is only ever applied while
 * this holds, so a person who scrolled up to read is never yanked back.
 */
export function isPinnedToLatest(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = TRANSCRIPT_STICK_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

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
  /**
   * The sidebar themes this turn advanced (the [✓ theme] chips on
   * finalized user bubbles, VAL-VJS2-001) — derived from the REAL engine
   * diff of the turn's saved answers. History turns loaded from the server
   * carry no attribution (the redacted transcript is all the server
   * stores), so they show no chips: nothing is guessed.
   */
  readonly themes?: readonly string[];
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
  const [busy, setBusyState] = useState(false);
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
  const [paused, setPausedState] = useState(false);
  const [typingMode, setTypingMode] = useState(false);
  // The quick-questions stage's move-on (VAL-QQ-002): sticky once the
  // person leaves the stage for the talk stage — via the calm CTA or
  // the last card's save. Never reset while this visit continues (a
  // mid-session reveal of a previously-skipped question, or a purge,
  // must not yank the person off the live conversation onto the cards
  // mid-mic); a reload starts a fresh visit and the stage returns
  // honestly for whatever is still unanswered.
  const [quickQuestionsDismissed, setQuickQuestionsDismissed] = useState(false);
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
  // The fixed-height transcript pane (VAL-FIX-002): the scrollable
  // container on the talk stage, plus whether it is parked at the latest
  // turn (auto-scroll only applies while it is — scrolled up is honored).
  const transcriptPaneRef = useRef<HTMLDivElement | null>(null);
  const transcriptPinnedRef = useRef(true);
  // Stable attach callback: a freshly attached pane (the talk stage
  // entered or re-entered — after a purge, a consent re-grant, or the
  // typing switch and back) starts PARKED at the latest turn. The
  // person's scroll position does not survive the pane leaving the
  // stage, so a new pane must never inherit a stale "scrolled up" pin
  // — that would silently kill auto-scroll for the whole stage (the
  // droid-review P1 on PR #90).
  const attachPaneRef = useCallback((el: HTMLDivElement | null): void => {
    transcriptPaneRef.current = el;
    if (el !== null) {
      transcriptPinnedRef.current = true;
    }
  }, []);
  // The entry mode chosen on the home shell (VAL-FIX-003), carried as a
  // preselection for the engine-gated entry stage. Read once on mount.
  const [suggestedMode, setSuggestedMode] =
    useState<ConversationEntryMode | null>(null);
  // The continuous voice session (HACK-106): all mic/recorder/endpointing
  // wiring lives behind ONE stable ref — the component only maps session
  // events to UI state and submits the utterances.
  const sessionRef = useRef<VoiceSession | null>(null);
  // The session's onUtterance callback is captured once at begin(); routing
  // it through a latest-ref keeps every utterance running with THIS
  // render's submit function — the busy guard, the consent re-check, and
  // the receipt header always read the current values (claude-review P2:
  // no stale closure across a long-lived session).
  const submitVoiceTurnRef = useRef<
    ((
      blob: Blob,
      queuedTiming?: { timing: EndpointTiming; decisionAt: number } | null,
    ) => Promise<void>) | null
  >(null);
  // Ref mirrors of busy/paused for the VOICE path (VAL-FIX-001): its
  // callbacks re-enter from async hops (recorder onstop, the settled
  // turn's cleanup) where the render closures can be stale — a queued
  // continuation submitted from the settled cleanup must see busy=false
  // NOW, not the value from the render that started the previous turn.
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  // True from the moment a reply's playback hold starts until the turn
  // settles: while it stands, NO code path may reopen the microphone —
  // the endpointer must never hear the assistant's own voice
  // (claude-review round 3: the invariant is enforced here, not left to
  // the session's internal paused check alone).
  const playbackHoldRef = useRef(false);
  const setBusy = useCallback((value: boolean): void => {
    busyRef.current = value;
    setBusyState(value);
  }, []);
  const setPaused = useCallback((value: boolean): void => {
    pausedRef.current = value;
    setPausedState(value);
  }, []);
  // Continuation utterances that ended while a turn was still processing
  // (VAL-FIX-001: speech resuming after an endpoint decision re-opens
  // cleanly): queued in ORDER — each with its own endpoint decision
  // timing — and submitted one-by-one as each in-flight turn settles.
  // Nothing the person said is dropped. Cleared wherever the session
  // ends or voice consent is revoked (never send captured audio after
  // the person withdrew it).
  const pendingVoiceRef = useRef<
    { blob: Blob; timing: { timing: EndpointTiming; decisionAt: number } | null }[]
  >([]);
  // VAL-FIX-001 instrumentation: the endpoint decision's timing, from
  // the gate through turn submission. Timing only — no transcript, no
  // audio, no PII. Rendered as a data attribute (no visual change) so
  // the budget is observable in the browser too.
  const endpointTimingRef = useRef<{
    timing: EndpointTiming;
    decisionAt: number;
  } | null>(null);
  const [endpointEvidence, setEndpointEvidence] = useState<string | null>(
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

  // The home shell's carried mode choice (VAL-FIX-003): consumed ONCE on
  // mount and applied as the entry stage's preselection — the session
  // still begins only from the person's explicit "Let's begin" behind the
  // consent gate. Deferred a microtask past hydration (the same idiom as
  // the capability probe) — no synchronous setState in the effect.
  useEffect(() => {
    void Promise.resolve().then(() => {
      const carried = takeStoredEntryMode();
      if (carried) {
        setSuggestedMode(carried);
      }
    });
  }, []);

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

  // The voice journey (VAL-VJS-001..004 + VAL-QQ-002 + VAL-INC-001) —
  // the full five-stage flow: ENTRY (the mode choice, VAL-VJS-001) →
  // QUICK QUESTIONS (the requirements engine's computed cards — only
  // while any are pending and not yet moved past) → TALK (the clean
  // transcript stage, VAL-VJS-002) → INCOME (the income-capture stage —
  // exactly two real source cards, manual + tax-return upload) → RESULTS
  // (VAL-VJS-003). The auto-advance's "complete" is REDEFINED DELIBERATELY
  // (VAL-QQ-011, milestone income-capture): results = intake complete
  // (state.complete — the engine's every-visible-question-answered) AND
  // income handled (state.income.handled — the income stage's own paths
  // captured or confirmed income at least once). So a session whose talk
  // stage completes lands on the INCOME stage first; results becomes
  // reachable only after the person confirms or types their income there;
  // no session reaches results with income unresolved, and no session is
  // dead-ended (the manual card is always available — a rough idea is
  // okay). A zero-pending quick-questions visitor passes straight through
  // to the talk stage — that stage is never shown empty. Every non-voice
  // path (consent panel open, zero-send, ai-only typed) keeps the
  // single-scroll layout untouched — with consent declined the
  // deterministic wizard covers the quick questions AND the income
  // questions among its questions and reaches every section (VAL-QQ-010:
  // refusal never blocks; the wizard makes zero model sends).
  const voiceConsented =
    !panelOpen && !zeroSend && aiSharingOn && voiceSharingOn;
  const journeyComplete = state?.complete ?? false;
  const incomeHandled = state?.income.handled ?? false;
  const quickQuestionsPending =
    (state?.quickQuestions.remainingCount ?? 0) > 0;
  const resultsStage = voiceConsented && journeyComplete && incomeHandled;
  const entryStage = voiceConsented && entryMode === null && !resultsStage;
  const quickQuestionsStage =
    voiceConsented &&
    entryMode !== null &&
    !journeyComplete &&
    quickQuestionsPending &&
    !quickQuestionsDismissed;
  const incomeStage =
    voiceConsented && entryMode !== null && journeyComplete && !incomeHandled;
  const talkStage =
    voiceConsented &&
    entryMode !== null &&
    !journeyComplete &&
    !quickQuestionsStage;

  // Surface conditions (the two-mode rule, VAL-NCF-002): mode A shows no
  // typing at all; mode B offers the switch at any point; the typed form
  // carries the ai-only, switched, and mic-fallback cases. The income
  // stage renders neither (the conversation is complete there; its own
  // cards are the surface).
  const voiceSessionSurface = talkStage && sessionOn && !typingMode;
  const typedSurface =
    !panelOpen &&
    !zeroSend &&
    aiSharingOn &&
    !resultsStage &&
    !incomeStage &&
    (!voiceSharingOn || typingMode || micBlocked);

  // Auto-scroll (VAL-FIX-002): the talk-stage transcript is a
  // fixed-height pane — keep the latest turns in view WITHOUT ever
  // growing the page. New turns AND streaming partials (the live-caret
  // bubble rides the voice phase) scroll the PANE to the bottom, only
  // while the person is parked there; scrolled up, it is never yanked.
  // The single-scroll paths (typed/zero-send) keep the page-level
  // scrollIntoView behavior.
  useEffect(() => {
    if (!talkStage) {
      transcriptEndRef.current?.scrollIntoView({ block: "nearest" });
      return;
    }
    const pane = transcriptPaneRef.current;
    if (pane === null || !transcriptPinnedRef.current) {
      return;
    }
    pane.scrollTop = pane.scrollHeight;
  }, [turns, voicePhase, talkStage]);

  function handlePaneScroll(): void {
    const pane = transcriptPaneRef.current;
    if (pane === null) {
      return;
    }
    transcriptPinnedRef.current = isPinnedToLatest(
      pane.scrollTop,
      pane.scrollHeight,
      pane.clientHeight,
    );
  }

  // Revoking voice consent mid-session stops the microphone immediately
  // and lands the person in the typed conversation (never a dead end).
  useEffect(() => {
    if (!voiceSharingOn && sessionRef.current !== null) {
      sessionRef.current.stop();
      sessionRef.current = null;
      clearPendingVoice();
      setSessionOn(false);
      setPaused(false);
      setTypingMode(true);
      setNotice(
        "Voice sharing turned off, so the microphone is off. Type below — it works exactly the same way.",
      );
    }
  }, [voiceSharingOn, setPaused]);

  // The journey is complete (VAL-VJS-003): the voice session ends with
  // it — no further listening once the results stage renders. Covers both
  // the live final turn and a reload onto an already-complete session.
  useEffect(() => {
    if (journeyComplete && sessionRef.current !== null) {
      sessionRef.current.stop();
      sessionRef.current = null;
      clearPendingVoice();
      setSessionOn(false);
      setPaused(false);
    }
  }, [journeyComplete, setPaused]);

  // Full teardown on unmount: no orphaned mic or audio context.
  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
      clearPendingVoice();
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
  }, [panelOpen, setPaused]);

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

  // Whether this fresh state leaves income handled — the results gate's
  // second conjunct (VAL-QQ-011). Module-level truth, no closure capture.
  function incomeHandledNow(state: IntakeClientState): boolean {
    return state.income.handled;
  }

  // The results stage's spoken wrap-up (VAL-VJS-003), moved here from the
  // completion turn by the income-capture redefinition: results arrives
  // when the INCOME stage completes (the completion turn now hands off to
  // the income stage), so the wrap-up speaks at the actual hand-off. Local
  // speech only (UI copy, not an assistant turn — the speak route is not
  // involved), bounded exactly as before: speechSynthesis quirks must
  // never leave the interaction unsettled.
  async function speakResultsWrapUp(): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => {
        const spoke = queueSpeech(RESULTS_WRAP_UP, undefined, resolve);
        if (!spoke) {
          resolve();
        }
      }),
      new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.max(5_000, 2_000 + RESULTS_WRAP_UP.length * 80),
        ),
      ),
    ]);
  }

  // The income stage's fresh-state application (its saves and confirms
  // flow through here): when the income gate turns handled, the journey
  // hands off to results — with the spoken wrap-up when voice is on.
  async function applyIncomeState(fresh: IntakeClientState): Promise<void> {
    const wasHandled = state?.income.handled ?? false;
    setState(fresh);
    if (!wasHandled && fresh.income.handled) {
      setNotice("Your income step is complete. Your results are ready.");
      if (voiceSharingOn) {
        sessionRef.current?.hold();
        playbackHoldRef.current = true;
        setVoicePhase("speaking");
        await speakResultsWrapUp();
      }
    }
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
    // The transcript chips (VAL-VJS2-001): the questions THIS turn saved,
    // diffed against the engine state before it, mapped to their sidebar
    // themes. Real engine state only — a turn that answers nothing new
    // shows no chip.
    const previouslyAnswered = new Set(Object.keys(state?.answers ?? {}));
    const newlyAnswered = Object.keys(data.state.answers).filter(
      (questionId) => !previouslyAnswered.has(questionId),
    );
    const turnThemes = themesForQuestionIds(newlyAnswered);
    setTurns((previous) => [
      ...previous,
      {
        id: nextLocalTurnId(),
        role: "user",
        transcript: data.redactedUserTranscript,
        ...(turnThemes.length > 0 ? { themes: turnThemes } : {}),
      },
      { id: nextLocalTurnId(), role: "assistant", transcript: data.assistantReply },
    ]);
    setState(data.state);
    setDraft("");
    setNotice(
      data.nextQuestionId
        ? "The assistant asked the next question."
        : incomeHandledNow(data.state)
          ? "Your conversation is complete. Your results are ready."
          : "Your conversation is complete. One more step: your income details.",
    );
    if (spoken && voiceSharingOn) {
      // The reply is about to speak: suspend capture FIRST, so the
      // endpointer can never hear the assistant's own voice — with a
      // 400 ms hangover, a cycle left open during playback would commit
      // the reply audio as a user turn (self-echo). If the person
      // resumed speaking and is mid-utterance right now, their open
      // recording is flushed gracefully (endpointNow delivers it — it
      // queues as a continuation) instead of being truncated silently.
      // The settled cleanup resumes listening (VAL-FIX-001).
      if (sessionRef.current?.isCapturing) {
        sessionRef.current.endpointNow();
      }
      sessionRef.current?.hold();
      playbackHoldRef.current = true;
      setVoicePhase("speaking");
      await speakReply(data.assistantTurnId, data.assistantReply);
    }
    // The auto-advance (VAL-VJS-003 + the income-capture redefinition,
    // VAL-QQ-011): the completed turn hands the journey to the INCOME
    // stage (results = intake complete AND income handled), so the spoken
    // wrap-up waits for the income stage's completion — the income stage's
    // save handler speaks it when the fresh state turns results-reachable
    // (speakResultsWrapUp). The conversation-engine's provenances can
    // never satisfy the income gate (user_supplied/ai_drafted only), so a
    // completion turn never lands on results directly.
    if (data.state.complete && !wasComplete && voiceSharingOn && entryMode !== null) {
      // The echo-proof holds while the reply and the next stage's arrival
      // settle: the turn is held open (the settled cleanup resumes
      // listening only when the turn settles — and the journey-complete
      // effect ends the session once intake is complete).
      sessionRef.current?.hold();
      playbackHoldRef.current = true;
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
      // A typed turn can also play audio (the spoken wrap-up) and run
      // alongside an active voice session: the same settled cleanup
      // applies (resume + queued continuation, VAL-FIX-001).
      settleVoiceAfterTurn();
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

  async function submitVoiceTurn(
    recorded: Blob,
    queuedTiming?: { timing: EndpointTiming; decisionAt: number } | null,
  ): Promise<void> {
    if (busyRef.current) {
      // A continuation spoken while a turn is still processing
      // (VAL-FIX-001): queued in order — WITH its own endpoint timing —
      // and submitted when the in-flight turns settle; speech resuming
      // after an endpoint decision re-opens the turn cleanly instead of
      // being dropped. Capture keeps running so whatever comes next is
      // heard too. The queue is BOUNDED (claude-review round 4: runaway
      // noise must not chain unlimited model turns) and overflow is
      // dropped HONESTLY — the person is told, never silently.
      const decided = queuedTiming ?? endpointTimingRef.current;
      endpointTimingRef.current = null;
      if (pendingVoiceRef.current.length >= MAX_PENDING_VOICE_TURNS) {
        setNotice(
          "We're catching up with what you said — we may have missed some of it just now. Say it again whenever you like.",
        );
      } else {
        pendingVoiceRef.current.push(
          decided === null ? { blob: recorded, timing: null } : { blob: recorded, timing: decided },
        );
      }
      // Never reopen the mic while a reply is playing (playbackHoldRef):
      // the assistant's own voice must not be captured as a user turn.
      if (!playbackHoldRef.current) {
        restartListeningIfActive();
      }
      return;
    }
    setBusy(true);
    // Capture resumes IMMEDIATELY with the turn in flight (VAL-FIX-001's
    // clean re-open): the next thing the person says after the endpoint
    // decision is captured while the model works, not swallowed by dead
    // air. Playback is separately guarded (the hold before a reply
    // speaks), so the assistant's own voice is never captured.
    restartListeningIfActive();
    setError(null);
    setNotice("Transcribing your recording…");
    // VAL-FIX-001 instrumentation: the decision timing this turn's gate
    // fire reported (attached at queue time for continuations),
    // completed with the submission leg. Timing only — no transcript,
    // no audio, no PII.
    const decided = queuedTiming ?? endpointTimingRef.current;
    endpointTimingRef.current = null;
    if (decided !== null && decided !== undefined) {
      const speechEndToSubmitMs =
        decided.timing.speechEndToDecisionMs + (Date.now() - decided.decisionAt);
      console.debug(
        `[voice-endpointing] speech end → decision ${decided.timing.speechEndToDecisionMs} ms → turn submit ${speechEndToSubmitMs} ms (utterance ${decided.timing.utteranceMs} ms)`,
      );
      setEndpointEvidence(
        `decision=${decided.timing.speechEndToDecisionMs}ms;submit=${speechEndToSubmitMs}ms;utterance=${decided.timing.utteranceMs}ms`,
      );
    }
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
      // The turn settled: end the playback hold (unless the person
      // paused) and submit a queued continuation, if any.
      settleVoiceAfterTurn();
    }
  }

  // The settled-turn cleanup, shared by the voice and typed flows
  // (VAL-FIX-001): end the playback hold — resuming the listening cycle
  // unless the PERSON paused (their pause outlives any turn) — then
  // submit the next queued continuation, if any. Continuations submit
  // ONLY while voice consent still stands and the session is live:
  // revoking voice, ending the session, or a recorder failure clears
  // the queue instead of sending captured audio without consent
  // (claude-review round: consent hygiene). One per settle keeps the
  // submissions strictly in spoken order.
  function settleVoiceAfterTurn(): void {
    // The playback window is over, whatever happened to the turn.
    playbackHoldRef.current = false;
    if (!pausedRef.current) {
      sessionRef.current?.resume();
    }
    if (
      !consentPathEnabled("voice", cachedConsentSnapshot()) ||
      sessionRef.current === null ||
      !sessionRef.current.isActive
    ) {
      pendingVoiceRef.current = [];
      return;
    }
    const next = pendingVoiceRef.current.shift();
    if (next !== undefined) {
      void submitVoiceTurnRef.current?.(next.blob, next.timing);
    }
  }

  // Wherever the voice session ENDS, captured-but-unsent audio goes with
  // it — and the decision timing captured for it too (claude-review
  // round: the queue must never outlive the consented session).
  function clearPendingVoice(): void {
    pendingVoiceRef.current = [];
    endpointTimingRef.current = null;
    playbackHoldRef.current = false;
  }
  // Latest-ref wiring (see the ref's comment): the session callback reads
  // the CURRENT submit function on every utterance. An effect, not a
  // render-time write: the session delivers an utterance only after real
  // speech + silence (≥ seconds), never inside the commit-to-effect gap.
  useEffect(() => {
    submitVoiceTurnRef.current = submitVoiceTurn;
  });

  // The voice session's single begin path (VAL-QQ-002): the entry stage
  // RECORDS the mode; the talk-stage bootstrap effect below begins the
  // session when the talk stage renders (after the quick-questions stage
  // — the microphone is never open over the question cards); the mode-B
  // "use your voice instead" switch re-begins it by gesture. The ref
  // guard keeps every arrival (bootstrap effect, gesture, the await
  // window before the session ref is set) on ONE session — never two
  // recorder cycles racing.
  const sessionBeginningRef = useRef(false);

  async function beginVoiceSession(): Promise<void> {
    if (sessionBeginningRef.current || sessionRef.current !== null) {
      return;
    }
    sessionBeginningRef.current = true;
    // The consent gate for voice (VAL-CONSENT-003): with voice sharing
    // off, the microphone is NEVER started and no audio is transmitted.
    if (!consentPathEnabled("voice", receipt)) {
      sessionBeginningRef.current = false;
      setReopened(true);
      setNotice(
        "Voice sharing is off, so recording is off. Turn on voice sharing, or type your answer below — it works exactly the same way.",
      );
      return;
    }
    if (!voiceCaptureSupported()) {
      sessionBeginningRef.current = false;
      setMicBlocked(true);
      setNotice(
        "Voice input isn't available in this browser. You can type your answers below — they work exactly the same way.",
      );
      return;
    }
    const session = createVoiceSession(
      {
        onUtterance: (blob) => void submitVoiceTurnRef.current?.(blob),
        onPhase: (phase) => setVoicePhase(phase),
        onEndpointTiming: (timing) => {
          // VAL-FIX-001: the gate's endpoint decision, timestamped here
          // (the same clock the submission leg is measured with).
          endpointTimingRef.current = { timing, decisionAt: Date.now() };
        },
        onRecorderError: () => {
          // A mid-session recorder failure ends the session and lands the
          // person in the typed conversation (never a dead end, even in
          // the voice-only mode — the typed form is the mic fallback).
          // stop() releases the mic stream and audio context (claude-review
          // P2: no orphaned hardware while the UI says to type).
          sessionRef.current?.stop();
          sessionRef.current = null;
          clearPendingVoice();
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
      setSessionOn(true);
      setPaused(false);
      setTypingMode(false);
    } catch {
      // Permission denied or device unavailable: the typed path is the
      // answer — visible guidance, never a dead end (VAL-VOICE-005).
      setMicBlocked(true);
      setNotice(
        "Your microphone isn't available. You can type your answers below — they work exactly the same way.",
      );
    } finally {
      sessionBeginningRef.current = false;
    }
  }

  // The entry stage's begin (VAL-QQ-002): the choice is recorded, and the
  // quick-questions stage — when the requirements engine still has
  // questions to ask — comes BEFORE the talk stage's session. The
  // bootstrap effect begins the session the moment the talk stage
  // renders, whichever way it is reached.
  function handleEntryBegin(mode: ConversationEntryMode): void {
    setEntryMode(mode);
  }

  // The talk stage begins the voice session (VAL-QQ-002 stage order).
  // Reached three ways: the entry choice with nothing pending (straight
  // through), the quick-questions stage's calm CTA, and the last card's
  // save (the engine's remaining set empties — the talk stage renders).
  // Guards: one session (the beginning ref), never over typing (the
  // mode-B switch stopped the session on purpose), never over a blocked
  // mic (the typed surface is the answer, not a retry loop). Marks the
  // quick-questions stage moved-past so a mid-conversation answer that
  // REVEALS a skipped question (the engine's correction semantics) can
  // never yank the person off the live talk stage onto the cards.
  // beginVoiceSession rides the latest-ref (the same seam idiom as
  // submitVoiceTurnRef) so the effect always begins with THIS render's
  // closure — the consent receipt included.
  const beginVoiceSessionRef = useRef(beginVoiceSession);
  useEffect(() => {
    beginVoiceSessionRef.current = beginVoiceSession;
  });
  useEffect(() => {
    if (!talkStage || typingMode || micBlocked || entryMode === null) {
      return;
    }
    if (sessionRef.current !== null || sessionBeginningRef.current) {
      return;
    }
    setQuickQuestionsDismissed(true);
    void Promise.resolve().then(() => {
      void beginVoiceSessionRef.current();
    });
  }, [talkStage, typingMode, micBlocked, entryMode]);

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
    playbackHoldRef.current = false;
    setPaused(false);
    setNotice("");
    sessionRef.current?.resume();
  }

  function stopSession(): void {
    sessionRef.current?.stop();
    sessionRef.current = null;
    clearPendingVoice();
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
    void beginVoiceSession();
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

      <MatchSection refreshKey={turns.length + answersRefresh} stagger={resultsStage} />
      <ReviewSection refreshKey={turns.length + answersRefresh} stagger={resultsStage} />
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
        resultsStage
          ? "results"
          : talkStage
            ? "talk"
            : quickQuestionsStage
              ? "quick-questions"
              : incomeStage
                ? "income"
                : entryStage
                  ? "entry"
                  : undefined
      }
      // The frame's inner flow (VAL-FIX-006): the frame spans edge-to-edge
      // and this root carries the frame's side inset (32px on wide
      // viewports, 20px at the 760px rule). The talk-stage grid and the
      // bottom session deck break OUT of this inset with matched negative
      // margins and carry the prototype's own paddings, so both span the
      // full frame width exactly.
      className="flex w-full flex-1 flex-col gap-6 px-5 pt-6 pb-8 min-[761px]:px-8 min-[761px]:pb-10"
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
      stage is the clean mode-choice screen, the quick-questions stage the
      engine's question cards (VAL-QQ-002), the income stage its two source
      cards (VAL-INC-001/002), and the results stage replaces the
      conversation with the handoff — per the approved frames. The talk
      stage splits the stream with the "Coming Together" sidebar
      (VAL-VJS2-001); the typed paths keep today's single column. */}
      {!entryStage && !resultsStage && !quickQuestionsStage && !incomeStage ? (
        <div
          className={
            talkStage
              ? // The prototype's stage grid, copied literally
              // (VAL-FIX-006): `grid-template-columns: minmax(0,1fr) 195px`,
              // `padding: 35px 32px 20px`, `gap: 30px` — the conversation
              // column takes all remaining frame width, the sidebar is a
              // fixed 195px right rail. The matched negative margins break
              // the grid out of the frame's side inset so the grid ELEMENT
              // spans the full frame width and carries those paddings
              // itself. Breakpoints per the prototype: one column at
              // 1100px (the rail hides), block with 28px 20px paddings at
              // 760px. Shared verbatim with the quick-questions stage.
              STAGE_GRID_CLASS
              : undefined
          }
        >
          <section
            aria-labelledby="conversation-transcript-heading"
            className="flex min-w-0 flex-col gap-3"
            data-endpoint-timing={endpointEvidence ?? undefined}
          >
            <div className="flex items-center justify-between gap-4">
              <h2 id="conversation-transcript-heading" className="font-display text-2xl font-bold">
                Conversation
              </h2>
              {/* The presence orb (VAL-VJS-005): ambient decorative
              presence floating beside the conversation, bound to the same
              voice phase as the state bar — aria-hidden here, so the text
              surfaces (state bar caption, StatusRegion notice) remain the
              only announcements. On the talk stage for BOTH entry modes;
              it idles while the mode-B deck is typed into. */}
              <PresenceOrb phase={voicePhase} />
            </div>
            {loaded && turns.length === 0 ? (
              <p className="max-w-xl text-muted">
                Say hello, or answer the first question whenever you are ready.
              </p>
            ) : null}
            {/* The fixed-height scrollable pane (VAL-FIX-002), on the talk
            stage only: the conversation can grow without ever growing the
            page. Focusable with a label so keyboard and assistive tech can
            operate the scrollbar (a11y baseline); the section's heading
            association and the list's data attribute are untouched. The
            single-scroll paths render the same list without the pane.
            `relative` makes the pane the containing block for the turns'
            absolutely-positioned sr-only labels — without it their
            containing block is the document root, they escape the
            overflow clip, and every turn grows the page itself.
            The cap is the prototype's `.voice-scroll` (VAL-FIX-006):
            max-height 620px, overflow-y auto — bounded by 60vh on phones
            (below 761px) so the session deck's controls stay on screen
            once the transcript fills (claude-review P3). */}
            <div
              ref={talkStage ? attachPaneRef : undefined}
              data-transcript-pane={talkStage ? "true" : undefined}
              role={talkStage ? "region" : undefined}
              tabIndex={talkStage ? 0 : undefined}
              aria-label={talkStage ? "Conversation transcript" : undefined}
              onScroll={talkStage ? handlePaneScroll : undefined}
              className={
                talkStage
                  ? "relative max-h-[min(60vh,620px)] overflow-y-auto overscroll-contain min-[761px]:max-h-[620px]"
                  : undefined
              }
            >
              <ul className="flex flex-col gap-3" data-conversation-transcript>
              {turns.map((turn) =>
                turn.role === "user" ? (
                  <li
                    key={turn.id}
                    className="flex max-w-[85%] flex-col items-end gap-1 self-end"
                  >
                    <span className="sr-only">You said:</span>
                    <span className="rounded-3xl rounded-br-lg bg-foreground px-4 py-2.5 text-background">
                      {turn.transcript}
                    </span>
                    {turn.themes && turn.themes.length > 0 ? (
                      <span className="flex flex-wrap justify-end gap-1">
                        {turn.themes.map((themeId) => (
                          <span
                            key={themeId}
                            data-turn-chip={themeId}
                            className="rounded-full border border-teal/40 bg-teal-soft px-2 py-0.5 text-xs font-medium text-teal"
                          >
                            <span aria-hidden="true">✓</span>{" "}
                            {themeLabelFor(themeId)}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </li>
                ) : (
                  <li
                    key={turn.id}
                    className="max-w-[85%] self-start rounded-3xl rounded-bl-lg border border-surface-border bg-surface px-4 py-2.5"
                  >
                    <span className="sr-only">The assistant said:</span>
                    {turn.transcript}
                  </li>
                ),
              )}
              {/* The live-caret partial (VAL-VJS2-001): while the mic is
              open the person's side of the stream shows a blinking caret —
              where their words will land. No partial text exists yet (STT
              transcribes per finished utterance), so none is fabricated:
              the bubble carries no words. Decorative and aria-hidden — the
              listening state is conveyed in text by the state bar and the
              StatusRegion notice. */}
              {voicePhase === "listening" ? (
                <li
                  aria-hidden="true"
                  data-live-partial
                  className="flex min-h-11 max-w-[85%] items-center self-end rounded-3xl rounded-br-lg border border-teal/40 bg-teal-soft px-4 py-2.5"
                >
                  <span
                    data-live-caret
                    className="live-caret inline-block h-4 w-0.5 rounded-full bg-teal"
                  />
                </li>
              ) : null}
              </ul>
              <div ref={transcriptEndRef} />
            </div>
          </section>
          {talkStage ? <ComingTogether state={state} /> : null}
        </div>
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
        <ModeChoice onBegin={handleEntryBegin} suggestedMode={suggestedMode ?? undefined} />
      ) : null}

      {/* The QUICK QUESTIONS stage (VAL-QQ-002): the requirements engine's
      computed set as grouped question cards — the honest live counter, the
      None-of-these exclusion, sensitive questions last with why-we-ask
      notes and a skip affordance that never blocks. Answers submit through
      the EXISTING tri-state path (POST /api/intake/answer →
      validateAnswerInput → saveAnswer; pii:true to the encrypted vault);
      the route's fresh client state flows back through onStateChange, so
      the counter re-renders from the engine and a completed set hands the
      journey to the talk stage (whose bootstrap effect starts the voice
      session — the mic is never open over these cards). The stage shares
      the talk stage's literal Lovable grid and Coming Together rail. */}
      {quickQuestionsStage && state ? (
        <div className={STAGE_GRID_CLASS}>
          <QuickQuestionsStage
            state={state}
            onStateChange={(fresh) => {
              // The answer route's response IS the freshest client state
              // (it recomputed the engine view server-side) — apply it
              // directly. No answersRefresh bump: the match/review
              // sections are not mounted on this stage, and a history
              // refetch would only race the route's own fresher state.
              setState(fresh);
            }}
            onNotice={setNotice}
            onToTalk={() => setQuickQuestionsDismissed(true)}
          />
          <ComingTogether state={state} stage="quick-questions" />
        </div>
      ) : null}

      {/* The INCOME stage (VAL-INC-001/002): the journey's fourth stage,
      after the talk stage's completion and before results — exactly two
      real source cards (type it in yourself, or upload your tax return)
      and no dead ends. Its saves apply the routes' fresh state through
      applyIncomeState, which hands the journey to the results stage when
      the income gate turns handled (VAL-QQ-011's deliberate redefinition).
      The stage shares the literal Lovable grid and the Coming Together
      rail. */}
      {incomeStage && state ? (
        <div className={STAGE_GRID_CLASS}>
          <IncomeStage
            state={state}
            onStateChange={(fresh) => {
              void applyIncomeState(fresh);
            }}
            onNotice={setNotice}
          />
          <ComingTogether state={state} stage="income" />
        </div>
      ) : null}

      {voiceSessionSurface ? (
        <div
          data-voice-bottom
          // The bottom session deck spans the FULL frame width
          // (VAL-FIX-006): the matched negative margins break out of the
          // frame's side inset and the wrapper carries the prototype's
          // `padding: 15px 32px 0` (10px 16px at the 760px rule).
          className="-mx-5 px-4 pt-[10px] min-[761px]:-mx-8 min-[761px]:px-8 min-[761px]:pt-[15px]"
        >
          <VoiceDeck
            phase={voicePhase}
            sessionState={paused ? "paused" : "active"}
            caption={
              <>
                <VoiceInterimState phase={voicePhase} />
                {builtInVoiceFallback ? (
                  <p
                    data-voice-fallback-badge
                    className="rounded-full border border-amber-ink px-3 py-1 text-sm font-medium text-amber-ink"
                  >
                    Hearing the built-in voice — the assistant&apos;s usual voice
                    is unavailable right now.
                  </p>
                ) : null}
              </>
            }
            controls={
              paused ? (
                <button
                  type="button"
                  data-voice-resume
                  onClick={resumeSession}
                  // A resume while a turn is in flight would start a second
                  // recorder cycle alongside the turn's own (claude-review
                  // P2): resume waits for the turn to settle.
                  disabled={busy}
                  aria-label="Resume listening"
                  title="Resume listening"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-teal-deep text-teal-contrast hover:bg-teal disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <PlayIcon />
                </button>
              ) : (
                <button
                  type="button"
                  data-voice-pause
                  onClick={holdSession}
                  disabled={busy}
                  aria-label="Pause"
                  title="Pause"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-teal text-teal hover:bg-teal-soft disabled:opacity-50"
                >
                  <PauseIcon />
                </button>
              )
            }
            tools={
              <>
                <span className="text-sm text-muted">
                  {paused
                    ? "Paused."
                    : entryMode === "voice-only"
                      ? "Speak freely — the assistant hears when you finish a thought."
                      : "Speak freely; switch to typing whenever you like."}
                </span>
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
              </>
            }
          />
          {/* The honesty strip (VAL-FIX-006): the prototype frame's bottom
          honesty strip, bleeding to the frame edges (`margin: 0 -32px`;
          -16px at the 760px rule). The words are prod's own honesty
          sentence — the layout is copied, the copy is not. Text size is
          rem-based (never a fixed px) so the huge-text zoom scales it,
          muted per the de-emphasized strip look. */}
          <div
            data-honesty-strip
            className="-mx-4 flex items-center justify-center gap-2 border-t border-dashed border-surface-border px-5 py-4 text-sm text-muted min-[761px]:-mx-8"
          >
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] shrink-0 border border-foreground"
            />
            <span>Nothing is submitted — you decide what happens next.</span>
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
      {micBlocked && !panelOpen && aiSharingOn && !resultsStage && !incomeStage ? (
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
          {/* The honest send control (VAL-VJS2-002, HACK-116 decision 2):
          "Send my application" ROUTES — to the signature step, the filled-
          form download, and the how/where-to-submit guidance below. Its
          click never performs or simulates a submission: no session change,
          no network call, no spinner-success theater, no receipt. The only
          confirmation that exists is the person marking the journey
          submitted themselves, after the fact. */}
          <button
            type="button"
            data-action="send-application"
            onClick={() => {
              const target =
                document.querySelector("[data-signature-step]") ??
                document.querySelector("[data-handoff]");
              target?.scrollIntoView();
              document.getElementById("signature-input")?.focus();
            }}
            className="self-start rounded-full bg-teal-deep px-8 py-3 text-base font-semibold text-teal-contrast hover:bg-teal"
          >
            Send my application
          </button>
          {/* The staggered rules-check + fill reveal (VAL-VJS2-001): the
          same real sections, paced in one after the other. Reduced-motion
          users see them immediately (the stagger is CSS, defined only under
          prefers-reduced-motion: no-preference). */}
          <div data-stagger-group className="flex flex-col gap-6">
            {journeySections}
          </div>
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
