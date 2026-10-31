// The endpointing gate (HACK-106 natural conversation, VAL-NCF-001; the
// endpoint TIMING is VAL-FIX-001): the continuous voice session replaces
// the per-question record/stop ritual — the person just talks, and an
// utterance ENDS from speech shape alone (a burst of speech followed by
// sustained low energy), or at a hard cap for a monologue. Pure state
// machine over (rms, now) samples: the browser wiring
// (src/app/intake/conversation/conversation-chat.tsx) feeds it from an
// AnalyserNode ~10x per second and stops the recorder when it fires.
//
// The tuning follows open-source energy-VAD practice (VAL-FIX-001, the
// demo-day "~10 s of dead air" bug): pipecat's Silero VAD confirms speech
// stop after 0.2 s of silence (stop_secs, chosen so STT finalizes
// sooner), LiveKit commits a turn with a 0.3–0.5 s endpointing delay and
// requires its VAD silence to be ≥ 0.25 s. A SHORT hangover after the
// last speech sample — not a long fixed gate — is what makes the
// endpoint decision land within ~1 second of speech end.

export interface EndpointingConfig {
  /** RMS (0..1) above which a sample counts as speech. */
  readonly rmsThreshold: number;
  /** Speech shorter than this never arms an utterance (coughs, clicks). */
  readonly minSpeechMs: number;
  /**
   * The HANGOVER: sustained low energy this long, after armed speech,
   * ends the utterance. The decision lands within
   * silenceEndpointMs + one poll interval of speech-energy end.
   */
  readonly silenceEndpointMs: number;
  /** Hard cap on one utterance, armed or not (a runaway open mic). */
  readonly maxUtteranceMs: number;
}

/**
 * Shipped tuning (VAL-FIX-001, documented in the PR): a 400 ms hangover
 * — the top of the researched 200–400 ms band, so a natural hesitation
 * under ~400 ms keeps the utterance open while a finished thought ends
 * promptly — 250 ms of minimum speech (cough/click rejection, and
 * LiveKit's VAD silence floor), the same RMS threshold as before, and
 * the same two-minute runaway cap. The previous fixed 1,600 ms gate is
 * the "before" measurement in the PR's before/after evidence.
 */
export const DEFAULT_ENDPOINTING: EndpointingConfig = {
  rmsThreshold: 0.015,
  minSpeechMs: 250,
  silenceEndpointMs: 400,
  maxUtteranceMs: 120_000,
};

/** The timing of one endpoint decision (VAL-FIX-001 instrumentation). */
export interface EndpointTiming {
  /** ms from the last above-threshold speech sample to the decision. */
  readonly speechEndToDecisionMs: number;
  /** ms from the utterance's first speech sample to the decision. */
  readonly utteranceMs: number;
}

export interface EndpointingGate {
  /**
   * Feed one audio sample. Returns true EXACTLY ONCE when the utterance
   * has ended (silence after speech, or the hard cap); false keeps
   * listening. After a true return the gate is inert until reset().
   */
  feed(rms: number, nowMs: number): boolean;
  /**
   * The most recent endpoint decision's timing, for instrumentation;
   * null until the gate fires and cleared by reset().
   */
  lastEndpoint(): EndpointTiming | null;
  /** Re-arm for a fresh utterance (a new listening cycle). */
  reset(): void;
}

/**
 * The gate's shape: quiet (no speech yet), a speech run that may arm once
 * it is long enough, and a fired flag that reports the endpoint exactly
 * once. Silence that starts before arming cancels the run (a cough);
 * silence after arming counts down to the endpoint. Speech resuming
 * AFTER a decision is a fresh utterance: the gate stays inert until
 * reset() re-arms it (the session's next listening cycle).
 */
export function createEndpointingGate(
  config: EndpointingConfig = DEFAULT_ENDPOINTING,
): EndpointingGate {
  let runStartMs: number | null = null;
  let lastLoudMs: number | null = null;
  let armed = false;
  let fired = false;
  let lastTiming: EndpointTiming | null = null;

  function clearRun(): void {
    runStartMs = null;
    lastLoudMs = null;
    armed = false;
  }

  return {
    feed(rms: number, nowMs: number): boolean {
      if (fired) {
        return false;
      }
      if (runStartMs !== null && nowMs - runStartMs >= config.maxUtteranceMs) {
        lastTiming = {
          speechEndToDecisionMs: lastLoudMs === null ? 0 : nowMs - lastLoudMs,
          utteranceMs: nowMs - runStartMs,
        };
        fired = true;
        clearRun();
        return true;
      }
      if (rms > config.rmsThreshold) {
        if (runStartMs === null) {
          runStartMs = nowMs;
        }
        lastLoudMs = nowMs;
        if (!armed && nowMs - runStartMs >= config.minSpeechMs) {
          armed = true;
        }
        return false;
      }
      if (runStartMs !== null && lastLoudMs !== null) {
        if (nowMs - lastLoudMs >= config.silenceEndpointMs) {
          if (armed) {
            lastTiming = {
              speechEndToDecisionMs: nowMs - lastLoudMs,
              utteranceMs: nowMs - runStartMs,
            };
            fired = true;
            clearRun();
            return true;
          }
          // A sub-min-speech noise trailed by silence: never an utterance.
          clearRun();
        }
      }
      return false;
    },
    lastEndpoint(): EndpointTiming | null {
      return lastTiming;
    },
    reset(): void {
      fired = false;
      lastTiming = null;
      clearRun();
    },
  };
}
