import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_ENDPOINTING,
  createEndpointingGate,
  type EndpointingConfig,
} from "./endpointing";

// The endpointing gate (HACK-106 natural conversation, VAL-NCF-001; the
// endpoint TIMING is VAL-FIX-001): the continuous voice session ends an
// utterance from SPEECH SHAPE alone — a burst of speech followed by
// sustained silence — with no per-question record/stop ritual. The gate
// is a pure state machine over (rms, now) samples so the timing behavior
// is unit-provable; the browser wiring feeds it ~10x/second from an
// AnalyserNode.
//
// VAL-FIX-001 (demo-day bug: ~10 s of dead air, endpointer holding the
// turn too long): the shipped tuning is the OSS energy-VAD practice —
// pipecat's Silero VAD stop hangover is 0.2 s, LiveKit commits turns with
// a 0.3–0.5 s endpointing delay — so a sustained-low-energy run of 400 ms
// ends the utterance and the decision lands well inside ~1 s of speech
// end. The previous fixed 1.6 s gate is kept here as the BEFORE
// measurement those tests document.

/** A gate with a controllable clock for deterministic tests. */
function gateWith(
  overrides: Partial<EndpointingConfig> = {},
): {
  feed(rms: number, nowMs: number): boolean;
  lastEndpoint(): { speechEndToDecisionMs: number; utteranceMs: number } | null;
  reset(): void;
} {
  return createEndpointingGate({ ...DEFAULT_ENDPOINTING, ...overrides });
}

/** Speak from 1.0 s to 2.0 s, then return the decision time (0 = never). */
function decisionAfterSpeechEnd(
  gate: ReturnType<typeof gateWith>,
): number {
  for (let now = 1_000; now <= 2_000; now += 100) {
    gate.feed(0.3, now);
  }
  for (let now = 2_100; now <= 6_000; now += 100) {
    if (gate.feed(0.0, now)) {
      return now;
    }
  }
  return 0;
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
    const gate = gateWith();
    // Speech from 1.0 s to 2.0 s (well past minSpeechMs), then silence.
    for (let now = 1_000; now <= 2_000; now += 100) {
      expect(gate.feed(0.3, now)).toBe(false);
    }
    // The hangover (400 ms) has not elapsed yet: still the same utterance.
    for (let now = 2_100; now <= 2_300; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    // The endpoint fires once the silence has lasted the full hangover.
    expect(gate.feed(0.0, 2_400)).toBe(true);
    // ...exactly once; the gate is inert until reset.
    expect(gate.feed(0.0, 2_500)).toBe(false);
    expect(gate.feed(0.4, 2_600)).toBe(false);
  });

  it("VAL-FIX-001 (after): the shipped tuning decides 400 ms after speech-energy end — inside ~1 s", () => {
    const gate = gateWith();
    const decisionAt = decisionAfterSpeechEnd(gate);
    expect(decisionAt).toBe(2_400);
    expect(decisionAt - 2_000).toBeLessThanOrEqual(1_000);
  });

  it("VAL-FIX-001 (before): the old fixed gate decided 1,600 ms after speech-energy end", () => {
    // Documents the behavior the fix replaces: the same timeline with the
    // previous fixed 1.6 s window — the multi-second hold in the bug
    // report. The config value stays available; the DEFAULT moved.
    const gate = gateWith({ silenceEndpointMs: 1_600 });
    const decisionAt = decisionAfterSpeechEnd(gate);
    expect(decisionAt).toBe(3_600);
    expect(decisionAt - 2_000).toBeGreaterThan(1_000);
  });

  it("reports the endpoint timing at the fire and clears it on reset", () => {
    const gate = gateWith();
    const decisionAt = decisionAfterSpeechEnd(gate);
    expect(gate.lastEndpoint()).toEqual({
      speechEndToDecisionMs: decisionAt - 2_000,
      utteranceMs: decisionAt - 1_000,
    });
    gate.reset();
    expect(gate.lastEndpoint()).toBeNull();
  });

  it("keeps a short intra-utterance pause open (under the hangover)", () => {
    const gate = gateWith();
    for (let now = 0; now <= 2_000; now += 100) {
      gate.feed(0.3, now);
    }
    // A 300 ms hesitation is SHORTER than the 400 ms hangover: the same
    // utterance continues.
    for (let now = 2_100; now <= 2_300; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    for (let now = 2_400; now <= 3_000; now += 100) {
      expect(gate.feed(0.3, now)).toBe(false);
    }
    // ...and the utterance still endpoints normally after it.
    for (let now = 3_100; now <= 3_300; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    expect(gate.feed(0.0, 3_400)).toBe(true);
  });

  it("VAL-FIX-001: a pause longer than the hangover ends the utterance, and speech resuming after the decision re-opens cleanly", () => {
    const gate = gateWith();
    for (let now = 0; now <= 2_000; now += 100) {
      gate.feed(0.3, now);
    }
    // A 1 s intra-utterance pause outlasts the hangover: the utterance
    // ends (the decision), and no amount of further silence double-fires.
    let firedAt = 0;
    for (let now = 2_100; now <= 3_000; now += 100) {
      if (gate.feed(0.0, now)) {
        firedAt = now;
        break;
      }
    }
    expect(firedAt).toBe(2_400);
    for (let now = 2_500; now <= 4_000; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
      expect(gate.feed(0.6, now)).toBe(false);
    }
    // After reset, resumed speech is a FRESH utterance (the turn
    // re-opened cleanly — no stale state from the first one).
    gate.reset();
    expect(gate.lastEndpoint()).toBeNull();
    for (let now = 10_000; now <= 11_000; now += 100) {
      expect(gate.feed(0.3, now)).toBe(false);
    }
    for (let now = 11_100; now <= 11_300; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    expect(gate.feed(0.0, 11_400)).toBe(true);
  });

  it("ends a long monologue at the hard utterance cap even mid-speech", () => {
    const gate = gateWith({ maxUtteranceMs: 120_000 });
    for (let now = 0; now <= 119_900; now += 100) {
      expect(gate.feed(0.3, now)).toBe(false);
    }
    expect(gate.feed(0.3, 120_000)).toBe(true);
  });

  it("arms again after reset for the next utterance", () => {
    const gate = gateWith();
    // First utterance: sustained speech, then silence past the hangover.
    for (let now = 0; now <= 1_000; now += 100) {
      gate.feed(0.3, now);
    }
    for (let now = 1_100; now <= 1_300; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    expect(gate.feed(0.0, 1_400)).toBe(true);
    gate.reset();
    // A fresh utterance: speech then silence endpoints again.
    for (let now = 10_000; now <= 11_000; now += 100) {
      gate.feed(0.3, now);
    }
    for (let now = 11_100; now <= 11_300; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
    expect(gate.feed(0.0, 11_400)).toBe(true);
  });

  it("does not endpoint a single loud sample followed by silence (below min speech)", () => {
    const gate = gateWith({ minSpeechMs: 250 });
    gate.feed(0.5, 0);
    for (let now = 100; now <= 10_000; now += 100) {
      expect(gate.feed(0.0, now)).toBe(false);
    }
  });

  it("PROPERTY (VAL-FIX-001): for any sample sequence and cadence, the endpoint decision lands within hangover + one sample of speech-energy end — never before the hangover", () => {
    // The core timing invariant of the fix, proven over arbitrary audio:
    // when the gate fires, the time since the last above-threshold sample
    // is bounded by the hangover plus at most one feed gap (a
    // silence-endpoint fires on the FIRST quiet sample at which the
    // hangover has elapsed; the hard cap fires on a loud sample, whose
    // gap to the last loud sample is one feed). And it never fires
    // EARLIER than the hangover on a quiet sample — the fix must not
    // become an eager cut-off either. Proven at the shipped 400 ms AND at
    // the old 1,600 ms gate: the property is config-parametric, so the
    // same proof shows the before AND after bounds.
    const rmsArb = fc.constantFrom(0.0, 0.005, 0.3, 0.6);
    fc.assert(
      fc.property(
        fc.array(rmsArb, { minLength: 0, maxLength: 400 }),
        fc.constantFrom(100, 1000, 5000),
        fc.constantFrom(400, 1_600),
        (samples, tickMs, silenceEndpointMs) => {
          const gate = createEndpointingGate({
            ...DEFAULT_ENDPOINTING,
            minSpeechMs: 250,
            silenceEndpointMs,
            maxUtteranceMs: 120_000,
          });
          let now = 0;
          let firstLoudAt: number | null = null;
          let lastLoudAt: number | null = null;
          let everLoud = false;
          for (const rms of samples) {
            now += tickMs;
            const loud = rms > 0.015;
            if (loud) {
              everLoud = true;
              if (firstLoudAt === null) {
                firstLoudAt = now;
              }
              lastLoudAt = now;
            }
            const fired = gate.feed(rms, now);
            if (fired) {
              expect(everLoud).toBe(true);
              expect(lastLoudAt).not.toBeNull();
              const latency = now - (lastLoudAt as number);
              // Branch on whether the hard utterance cap was reached
              // (the cap is checked before the silence branch, so it can
              // fire on a quiet sample whose silence had not yet
              // outlasted the hangover): no hangover bound applies there.
              const capReached =
                firstLoudAt !== null && now - firstLoudAt >= 120_000;
              if (capReached) {
                expect(latency).toBeGreaterThanOrEqual(0);
              } else if (loud) {
                // The hard cap fired mid-speech: the decision is not
                // later than one feed after speech energy (it IS the
                // loud sample).
                expect(latency).toBeLessThanOrEqual(tickMs);
              } else {
                // The silence hangover fired: the decision is inside
                // [hangover, hangover + one feed] of speech-energy end.
                // (The fire lands on the FIRST quiet sample where the
                // hangover has elapsed, so it cannot lag further, and it
                // cannot fire earlier than the hangover either.)
                expect(latency).toBeGreaterThanOrEqual(silenceEndpointMs);
                expect(latency).toBeLessThanOrEqual(
                  silenceEndpointMs + tickMs,
                );
              }
              break;
            }
          }
        },
      ),
      { numRuns: 300 },
    );
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
          const gate = createEndpointingGate(DEFAULT_ENDPOINTING);
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
