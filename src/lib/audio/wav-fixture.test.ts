import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeWavPcm16Mono, parseWavHeader, wavDurationMs } from "./wav";

// Committed voice fixtures (Mission v2 M2). `its-for-myself-16k.wav` is
// real macOS speech ("It's for myself.", `say` + `afconvert -f WAVE -d
// LEI16@16000 -c 1`); `its-for-myself-browser-encoded.wav` is the SAME
// audio re-encoded through the browser encoder pipeline this feature
// ships. The live STT route tests post both; this file proves offline,
// CI-safely, that the browser fixture is exactly what the current encoder
// produces from the recorded audio — an encoder change without regenerating
// the fixture fails here.

describe("committed voice fixtures", () => {
  const SOURCE = "specs/fixtures/voice/its-for-myself-16k.wav";
  const BROWSER = "specs/fixtures/voice/its-for-myself-browser-encoded.wav";

  it("both fixtures parse as Meta-accepted 16 kHz mono 16-bit PCM WAV", () => {
    for (const path of [SOURCE, BROWSER]) {
      const bytes = new Uint8Array(readFileSync(path));
      const info = parseWavHeader(bytes);
      expect(info, path).not.toBeNull();
      expect(info).toMatchObject({
        pcmFormat: 1,
        channels: 1,
        bitsPerSample: 16,
        sampleRate: 16000,
      });
      // A short spoken phrase: well under the 10-minute cap, not silence.
      const durationMs = wavDurationMs(info as NonNullable<typeof info>);
      expect(durationMs).toBeGreaterThan(500);
      expect(durationMs).toBeLessThan(10_000);
    }
  });

  it("the browser fixture is byte-identical to the current encoder's output", () => {
    const source = new Uint8Array(readFileSync(SOURCE));
    const info = parseWavHeader(source);
    expect(info).not.toBeNull();
    const view = new DataView(
      source.buffer,
      source.byteOffset,
      source.byteLength,
    );
    const samples = new Float32Array(Math.floor((info?.dataBytes ?? 0) / 2));
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = view.getInt16((info?.dataOffset ?? 0) + i * 2, true) / 0x8000;
    }
    const regenerated = new Uint8Array(
      encodeWavPcm16Mono(samples, info?.sampleRate ?? 16000),
    );
    const committed = new Uint8Array(readFileSync(BROWSER));
    expect(committed).toEqual(regenerated);
  });
});
