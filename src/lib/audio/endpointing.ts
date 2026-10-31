// The endpointing gate (HACK-106 natural conversation, VAL-NCF-001): the
// continuous voice session replaces the per-question record/stop ritual —
// the person just talks, and an utterance ENDS from speech shape alone
// (a burst of speech followed by sustained silence), or at a hard cap for
// a monologue. Pure state machine over (rms, now) samples: the browser
// wiring (src/app/intake/conversation/conversation-chat.tsx) feeds it from
// an AnalyserNode ~10x per second and stops the recorder when it fires.

export interface EndpointingConfig {
  /** RMS (0..1) above which a sample counts as speech. */
  readonly rmsThreshold: number;
  /** Speech shorter than this never arms an utterance (coughs, clicks). */
  readonly minSpeechMs: number;
  /** Silence, after armed speech, this long ends the utterance. */
  readonly silenceEndpointMs: number;
  /** Hard cap on one utterance, armed or not (a runaway open mic). */
  readonly maxUtteranceMs: number;
}

/**
 * Tuned for conversational turns: ~1.6 s of silence is a natural "I'm
 * done" in an intake interview (shorter truncates thinking pauses,
 * longer feels like the assistant stopped listening); a two-minute cap
 * bounds one utterance far above any realistic answer.
 */
export const DEFAULT_ENDPOINTING: EndpointingConfig = {
  rmsThreshold: 0.015,
  minSpeechMs: 250,
  silenceEndpointMs: 1_600,
  maxUtteranceMs: 120_000,
};

export interface EndpointingGate {
  /**
   * Feed one audio sample. Returns true EXACTLY ONCE when the utterance
   * has ended (silence after speech, or the hard cap); false keeps
   * listening. After a true return the gate is inert until reset().
   */
  feed(rms: number, nowMs: number): boolean;
  /** Re-arm for a fresh utterance (a new listening cycle). */
  reset(): void;
}

/**
 * The gate's shape: quiet (no speech yet), a speech run that may arm once
 * it is long enough, and a fired flag that reports the endpoint exactly
 * once. Silence that starts before arming cancels the run (a cough);
 * silence after arming counts down to the endpoint.
 */
export function createEndpointingGate(
  config: EndpointingConfig = DEFAULT_ENDPOINTING,
): EndpointingGate {
  let runStartMs: number | null = null;
  let lastLoudMs: number | null = null;
  let armed = false;
  let fired = false;

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
    reset(): void {
      fired = false;
      clearRun();
    },
  };
}
