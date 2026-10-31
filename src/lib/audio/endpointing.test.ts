import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_ENDPOINTING,
  createEndpointingGate,
  type EndpointingConfig,
} from "./endpointing";

// The endpointing gate (HACK-106 natural conversation, VAL-NCF-001): the
// continuous voice session ends an utterance from SPEECH SHAPE alone — a
// burst of speech followed by sustained silence — with no per-question
// record/stop ritual. The gate is a pure state machine over (rms, now)
// samples so the timing behavior is unit-provable; the browser wiring
// feeds it ~10x/second from an AnalyserNode.

/** A gate with a controllable clock for deterministic tests. */
function gateWith(
  overrides: Partial<EndpointingConfig> = {},
): { feed(rms: number, nowMs: number): boolean; reset(): void } {
  return createEndpointingGate({ ...DEFAULT_ENDPOINTING, ...overrides });
}

describe("the endpointing gate (VAL-NCF-001)", () => {
  it("never endpoints while the room stays silent", () => {
    const gate = gateWith();
    for (let now = 0; now <= 60_000; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
      expect(gate.feed(0.001, now)).toBe(false);
    }
  });

  it("ignores a brief noise that never becomes speech", () => {
    const gate = gateWith();
    // A 100 ms cough: loud for one sample only.
    expect(gate.feed(0.5, 1_000)).toBe(false);
    // Long silence after it: no utterance was ever armed.
    for (let now = 1_100; now <= 6_000; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
  });

  it("ends the utterance after sustained speech followed by silence", () => {
    const gate = gateWith({ silenceEndpointMs: 1_600 });
    // Speech from 1.0 s to 2.0 s (well past minSpeechMs), then silence.
    for (let now = 1_000; now <= 2_000; now += 100) {
      expect(gate.feed(0.3, now)).toBe(false);
    }
    for (let now = 2_100; now <= 3_500; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    // The endpoint fires once the silence has lasted the full window.
    expect(gate.feed(0.0, 3_600)).toBe(true);
    // ...exactly once; the gate is inert until reset.
    expect(gate.feed(0.0, 3_700)).toBe(false);
    expect(gate.feed(0.4, 3_800)).toBe(false);
  });

  it("does not endpoint when the person pauses mid-sentence under the silence window", () => {
    const gate = gateWith({ silenceEndpointMs: 1_600 });
    for (let now = 0; now <= 2_000; now += 100) {
      gate.feed(0.3, now);
    }
    // A 1 s intra-utterance pause is not an endpoint.
    for (let now = 2_100; now <= 3_000; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    // Speech resumes; the same utterance continues past the pause.
    expect(gate.feed(0.3, 3_100)).toBe(false);
    for (let now = 3_200; now <= 4_000; now += 100) {
      expect(gate.feed(0.3, now)).toBe(false);
    }
  });

  it("ends a long monologue at the hard utterance cap even mid-speech", () => {
    const gate = gateWith({ maxUtteranceMs: 120_000 });
    for (let now = 0; now <= 119_900; now += 100) {
      expect(gate.feed(0.3, now)).toBe(false);
    }
    expect(gate.feed(0.3, 120_000)).toBe(true);
  });

  it("arms again after reset for the next utterance", () => {
    const gate = gateWith({ silenceEndpointMs: 1_600 });
    // First utterance: sustained speech, then silence past the window.
    for (let now = 0; now <= 1_000; now += 100) {
      gate.feed(0.3, now);
    }
    for (let now = 1_100; now <= 2_500; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    expect(gate.feed(0.0, 2_600)).toBe(true);
    gate.reset();
    // A fresh utterance: speech then silence endpoints again.
    for (let now = 10_000; now <= 11_000; now += 100) {
      gate.feed(0.3, now);
    }
    for (let now = 11_100; now <= 12_500; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    expect(gate.feed(0.0, 12_600)).toBe(true);
  });

  it("does not endpoint a single loud sample followed by silence (below min speech)", () => {
    const gate = gateWith({ minSpeechMs: 250 });
    gate.feed(0.5, 0);
    for (let now = 100; now <= 10_000; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
  });

  it("PROPERTY: for any sample sequence, an endpoint fires at most once per arming, and only after speech", () => {
    // The loop-critical invariants, proven over arbitrary audio: a gate
    // that double-fired would send one utterance twice mid-speech, and a
    // gate that fired without armed speech would cut off a person
    // thinking in silence.
    const rmsArb = fc.constantFrom(0.0, 0.005, 0.3, 0.6);
    fc.assert(
      fc.property(
        fc.array(rmsArb, { minLength: 0, maxLength: 400 }),
        fc.constantFrom(100, 1000, 5000),
        (samples, tickMs) => {
          const gate = createEndpointingGate({
            ...DEFAULT_ENDPOINTING,
            minSpeechMs: 250,
            silenceEndpointMs: 1_600,
            maxUtteranceMs: 120_000,
          });
          let endpoints = 0;
          let now = 0;
          let everLoud = false;
          for (const rms of samples) {
            everLoud = everLoud || rms > 0.015;
            now += tickMs;
            if (gate.feed(rms, now)) {
              endpoints += 1;
              // A true return: the gate had seen speech before it, and no
              // further endpoint can fire until reset.
              expect(everLoud).toBe(true);
              expect(endpoints).toBe(1);
            }
          }
          expect(endpoints).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("PROPERTY: after reset, the gate can endpoint again for arbitrary fresh audio", () => {
    const rmsArb = fc.constantFrom(0.0, 0.005, 0.3, 0.6);
    fc.assert(
      fc.property(
        fc.array(rmsArb, { minLength: 0, maxLength: 200 }),
        (samples) => {
          const gate = createEndpointingGate(DEFAULT_ENDPOINTING);
          // Drive some audio, reset, drive more: the gate is never stuck.
          let now = 0;
          for (const rms of samples) {
            now += 100;
            gate.feed(rms, now);
          }
          gate.reset();
          let endpoints = 0;
          for (const rms of samples) {
            now += 100;
            if (gate.feed(rms, now)) {
              endpoints += 1;
            }
          }
          expect(endpoints).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
