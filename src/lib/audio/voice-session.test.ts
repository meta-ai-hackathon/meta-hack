import { describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINTING, type EndpointingConfig } from "./endpointing";
import {
  createVoiceSession,
  type VoiceSessionDeps,
  type VoiceSessionPhase,
} from "./voice-session";

// The continuous voice session (HACK-106, VAL-NCF-001): one mic session,
// recorder cycles per utterance, and endpointing that fires from speech
// shape — no per-question record/stop ritual. These tests drive the REAL
// session logic against injected browser fakes (recorder, analyser,
// scheduler), proving the loop: speech → silence → deliver; pause
// discards; the session survives across cycles; teardown is clean.

interface SessionHarness {
  deps: VoiceSessionDeps;
  /** The rms the fake analyser reports to the NEXT poll tick. */
  setRms(rms: number): void;
  /** Advance the scheduler by one poll tick. */
  tick(): void;
  cycleStarts: number[];
  setMicError(error: unknown): void;
}

function makeHarness(): SessionHarness {
  let rms = 0;
  let micError: unknown = null;
  let tickFn: (() => void) | null = null;
  // The fake clock: each poll tick advances 100 ms — the real poll's
  // cadence, and the resolution the gate's silence arithmetic needs.
  const nowMs = { value: 0 };
  const cycleStarts: number[] = [];
  const deps: VoiceSessionDeps = {
    getUserMedia: async () => {
      if (micError) {
        throw micError;
      }
      return { getTracks: () => [] } as unknown as MediaStream;
    },
    createRecorderCycle: (_stream, onBlob) => {
      cycleStarts.push(cycleStarts.length);
      return {
        start(): void {
          cycleStarts[cycleStarts.length - 1] = 1;
        },
        stop(deliver: boolean): void {
          // The real cycle's blob delivery rides the ASYNC recorder onstop;
          // the fake delivers synchronously — the synchronous-transcribing
          // contract is asserted separately via onPhase ordering.
          if (deliver) {
            onBlob(new Blob(["utterance-bytes"], { type: "audio/webm" }));
          }
        },
      };
    },
    createAnalyser: () => ({
      rms: () => rms,
      close: () => undefined,
    }),
    schedule: (tick) => {
      tickFn = tick;
      return () => {
        tickFn = null;
      };
    },
    now: () => nowMs.value,
  };
  return {
    deps,
    setRms: (value) => {
      rms = value;
    },
    tick: () => {
      nowMs.value += 100;
      tickFn?.();
    },
    cycleStarts,
    setMicError: (error) => {
      micError = error;
    },
  };
}

function makeSession(options?: {
  config?: EndpointingConfig;
}): {
  session: ReturnType<typeof createVoiceSession>;
  harness: SessionHarness;
  phases: VoiceSessionPhase[];
  utterances: Blob[];
  recorderErrors: number;
} {
  const harness = makeHarness();
  const phases: VoiceSessionPhase[] = [];
  const utterances: Blob[] = [];
  let recorderErrors = 0;
  const session = createVoiceSession(
    {
      onUtterance: (blob) => utterances.push(blob),
      onPhase: (phase) => phases.push(phase),
      onRecorderError: () => {
        recorderErrors += 1;
      },
    },
    options?.config ?? DEFAULT_ENDPOINTING,
    harness.deps,
  );
  return { session, harness, phases, utterances, recorderErrors };
}

/** Speak for a few ticks, then fall silent until the gate endpoints. */
function speakThenStop(harness: SessionHarness): void {
  harness.setRms(0.3);
  for (let i = 0; i < 6; i += 1) {
    harness.tick();
  }
  harness.setRms(0.0);
  for (let i = 0; i < 20; i += 1) {
    harness.tick();
  }
}

const CONFIG: EndpointingConfig = {
  rmsThreshold: 0.015,
  minSpeechMs: 250,
  silenceEndpointMs: 1_600,
  maxUtteranceMs: 120_000,
};

describe("the continuous voice session (VAL-NCF-001)", () => {
  it("delivers an utterance after speech then sustained silence, and listens again", async () => {
    const { session, harness, phases, utterances } = makeSession({
      config: CONFIG,
    });
    await session.begin();
    expect(phases).toEqual(["listening"]);

    speakThenStop(harness);
    // Exactly one utterance delivered, and the session is in the
    // transcribing phase — NO record button was pressed between them.
    expect(utterances).toHaveLength(1);
    expect(phases.at(-1)).toBe("transcribing");
    expect(session.isActive).toBe(true);
  });

  it("discards the in-flight utterance when the session pauses", async () => {
    const { session, harness, utterances } = makeSession({ config: CONFIG });
    await session.begin();
    harness.setRms(0.3);
    harness.tick();
    harness.tick();
    session.hold();
    expect(utterances).toHaveLength(0);
    expect(session.isPaused).toBe(true);
    // Listening while paused is a no-op.
    session.listen();
    harness.setRms(0.3);
    harness.tick();
    expect(utterances).toHaveLength(0);
    // Resume starts a fresh cycle that delivers again.
    session.resume();
    speakThenStop(harness);
    expect(utterances).toHaveLength(1);
  });

  it("ends a runaway utterance at the hard cap even with continuous speech", async () => {
    const { session, harness, utterances } = makeSession({
      config: { ...CONFIG, maxUtteranceMs: 1_000 },
    });
    await session.begin();
    harness.setRms(0.4);
    for (let i = 0; i < 15; i += 1) {
      harness.tick();
    }
    expect(utterances).toHaveLength(1);
  });

  it("keeps working across many utterances (one mic session, many cycles)", async () => {
    const { session, harness, utterances } = makeSession({ config: CONFIG });
    await session.begin();
    for (let turn = 0; turn < 3; turn += 1) {
      speakThenStop(harness);
      session.listen(); // the component's post-turn restart
    }
    expect(utterances).toHaveLength(3);
  });

  it("reports the transcribing phase synchronously at endpointNow", async () => {
    const { session, harness, phases } = makeSession({ config: CONFIG });
    await session.begin();
    harness.setRms(0.3);
    harness.tick();
    harness.tick();
    // The graceful stop control (a single press, no per-question ritual):
    // the transcribing phase is immediate, not after an async hop.
    session.endpointNow();
    expect(phases.at(-1)).toBe("transcribing");
  });

  it("stops cleanly: no delivery after stop, mic released", async () => {
    const { session, harness, utterances, phases } = makeSession({
      config: CONFIG,
    });
    await session.begin();
    harness.setRms(0.3);
    harness.tick();
    session.stop();
    harness.setRms(0.0);
    harness.tick();
    harness.tick();
    expect(utterances).toHaveLength(0);
    expect(phases.at(-1)).toBe(null);
    expect(session.isActive).toBe(false);
  });

  it("surfaces a mid-cycle recorder failure through onRecorderError", async () => {
    const phases: VoiceSessionPhase[] = [];
    let recorderErrors = 0;
    // A cycle factory whose start() fails like a real recorder would.
    const failingDeps: VoiceSessionDeps = {
      ...makeHarness().deps,
      createRecorderCycle: (_stream, _onBlob, onError) => ({
        start(): void {
          onError();
        },
        stop(): void {
          // Never delivers.
        },
      }),
    };
    const session = createVoiceSession(
      {
        onUtterance: () => undefined,
        onPhase: (phase) => phases.push(phase),
        onRecorderError: () => {
          recorderErrors += 1;
        },
      },
      CONFIG,
      failingDeps,
    );
    await session.begin();
    expect(recorderErrors).toBe(1);
    expect(phases.at(-1)).toBe(null);
    expect(session.isActive).toBe(false);
  });

  it("throws when the microphone is unavailable (the component falls back to typing)", async () => {
    const { session, harness } = makeSession({ config: CONFIG });
    harness.setMicError(new Error("denied"));
    await expect(session.begin()).rejects.toBeTruthy();
  });
});
