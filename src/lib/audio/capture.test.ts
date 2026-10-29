import { describe, expect, it } from "vitest";
import { pickRecorderMimeType, TARGET_SAMPLE_RATE } from "./capture";
import { encodeWavPcm16Mono, parseWavHeader } from "./wav";

// Browser capture helpers (Mission v2 M2). The DOM-dependent pipeline
// (decodeAudioData + OfflineAudioContext render) is verified in a real
// browser via agent-browser probes (VAL-VOICE-002); here the pure decision
// logic and its guards are unit-tested.

describe("pickRecorderMimeType", () => {
  it("prefers webm/opus, falls back to webm, then mp4 (Safari), then null", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(
      pickRecorderMimeType((type) => type === "audio/webm"),
    ).toBe("audio/webm");
    expect(
      pickRecorderMimeType((type) => type === "audio/mp4"),
    ).toBe("audio/mp4");
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });

  it("keeps the encoded sample rate at the Meta-accepted 16 kHz", () => {
    expect(TARGET_SAMPLE_RATE).toBe(16000);
  });
});

describe("the browser encoder's output is Meta-accepted WAV", () => {
  it("parses back as mono 16-bit integer PCM at the target rate", () => {
    const wav = new Uint8Array(
      encodeWavPcm16Mono(new Float32Array(160), TARGET_SAMPLE_RATE),
    );
    const info = parseWavHeader(wav);
    expect(info).toMatchObject({
      pcmFormat: 1,
      channels: 1,
      bitsPerSample: 16,
      sampleRate: TARGET_SAMPLE_RATE,
    });
  });
});
