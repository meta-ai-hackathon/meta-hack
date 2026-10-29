import { describe, expect, it } from "vitest";
import {
  encodeWavPcm16Mono,
  parseWavHeader,
  wavDurationMs,
} from "./wav";

// WAV codec tests (Mission v2 M2): the browser encodes 16 kHz mono 16-bit
// PCM WAV in-browser (no ffmpeg on Vercel serverless), and the STT client
// validates the uploaded bytes against the live-verified Meta contract
// (RIFF/WAVE, mono, 16-bit int PCM, 16 or 24 kHz only). The parser must
// accept both this encoder's canonical output and real-world encoders that
// prepend extra RIFF chunks (e.g. afconvert's LIST chunk).

function setAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function chunkId(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

describe("encodeWavPcm16Mono", () => {
  it("writes a canonical RIFF/WAVE header with PCM mono 16-bit fields", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = new Uint8Array(encodeWavPcm16Mono(samples, 16000));
    expect(bytes.byteLength).toBe(44 + samples.length * 2);
    expect(chunkId(bytes, 0)).toBe("RIFF");
    expect(chunkId(bytes, 8)).toBe("WAVE");
    expect(chunkId(bytes, 12)).toBe("fmt ");
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // integer PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(chunkId(bytes, 36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("round-trips sample values through a little-endian int16 decode", () => {
    const samples = new Float32Array([0, 0.25, -0.25, 0.999, -1]);
    const bytes = new Uint8Array(encodeWavPcm16Mono(samples, 16000));
    const view = new DataView(bytes.buffer);
    const decoded: number[] = [];
    for (let offset = 44; offset < bytes.byteLength; offset += 2) {
      decoded.push(view.getInt16(offset, true) / 0x8000);
    }
    expect(decoded[0]).toBe(0);
    expect(decoded[1]).toBeCloseTo(0.25, 2);
    expect(decoded[2]).toBeCloseTo(-0.25, 2);
    expect(decoded[3]).toBeGreaterThan(0.99);
    expect(decoded[4]).toBe(-1);
  });

  it("clamps out-of-range samples and handles an empty buffer", () => {
    const clamped = new Uint8Array(encodeWavPcm16Mono(new Float32Array([2, -2]), 24000));
    const view = new DataView(clamped.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);

    const empty = new Uint8Array(encodeWavPcm16Mono(new Float32Array(0), 16000));
    expect(empty.byteLength).toBe(44);
  });
});

describe("parseWavHeader", () => {
  it("round-trips this encoder's own output for arbitrary lengths and rates", () => {
    for (const [sampleCount, sampleRate] of [
      [1, 16000],
      [160, 16000],
      [2400, 24000],
    ] as const) {
      const bytes = new Uint8Array(
        encodeWavPcm16Mono(new Float32Array(sampleCount), sampleRate),
      );
      const info = parseWavHeader(bytes);
      expect(info).not.toBeNull();
      expect(info?.sampleRate).toBe(sampleRate);
      expect(info?.channels).toBe(1);
      expect(info?.bitsPerSample).toBe(16);
      expect(info?.pcmFormat).toBe(1);
      expect(info?.dataBytes).toBe(sampleCount * 2);
      expect(info?.dataOffset).toBe(44);
    }
  });

  it("walks extra RIFF chunks before fmt and data (afconvert-style files)", () => {
    // A LIST/INFO metadata chunk between WAVE and fmt, as real encoders emit.
    const listPayload = new TextEncoder().encode("INFOISFT" + "\u0000\u0000\u0000\u0003afconvert");
    const payloadSize = listPayload.length + (listPayload.length % 2);
    const totalSize = 4 + 8 + payloadSize + 8 + 16 + 8 + 4;
    const bytes = new Uint8Array(8 + totalSize);
    const view = new DataView(bytes.buffer);
    setAscii(view, 0, "RIFF");
    view.setUint32(4, totalSize, true);
    setAscii(view, 8, "WAVE");
    let offset = 12;
    setAscii(view, offset, "LIST");
    view.setUint32(offset + 4, payloadSize, true);
    bytes.set(listPayload, offset + 8);
    offset += 8 + payloadSize;
    setAscii(view, offset, "fmt ");
    view.setUint32(offset + 4, 16, true);
    view.setUint16(offset + 8, 1, true); // PCM
    view.setUint16(offset + 10, 1, true); // mono
    view.setUint32(offset + 12, 16000, true);
    view.setUint32(offset + 16, 32000, true);
    view.setUint16(offset + 20, 2, true);
    view.setUint16(offset + 22, 16, true);
    offset += 8 + 16;
    setAscii(view, offset, "data");
    view.setUint32(offset + 4, 4, true);
    view.setInt16(offset + 8, 100, true);
    view.setInt16(offset + 10, -100, true);

    const info = parseWavHeader(bytes);
    expect(info).not.toBeNull();
    expect(info?.sampleRate).toBe(16000);
    expect(info?.dataBytes).toBe(4);
    expect(info?.dataOffset).toBe(offset + 8);
  });

  it("rejects truncated, malformed, and non-PCM inputs", () => {
    const good = new Uint8Array(encodeWavPcm16Mono(new Float32Array(4), 16000));

    // Too short to hold a header.
    expect(parseWavHeader(new Uint8Array(12))).toBeNull();
    // Bad RIFF and WAVE magic.
    const badRiff = good.slice();
    badRiff[0] = 0x52 ^ 0xff;
    expect(parseWavHeader(badRiff)).toBeNull();
    const badWave = good.slice();
    badWave[9] = 0x45 ^ 0xff;
    expect(parseWavHeader(badWave)).toBeNull();
    // Missing data chunk: fmt claims samples that never arrive.
    const noData = good.slice(0, 36);
    expect(parseWavHeader(noData)).toBeNull();
    // Truncated data chunk: the header claims more audio than the bytes carry.
    const truncated = good.slice(0, 44 + 4);
    expect(parseWavHeader(truncated)).toBeNull();
    // Non-PCM format code (3 = IEEE float).
    const floatFmt = good.slice();
    new DataView(floatFmt.buffer).setUint16(20, 3, true);
    expect(parseWavHeader(floatFmt)).not.toBeNull(); // parser reports; the client rejects
    expect(parseWavHeader(floatFmt)?.pcmFormat).toBe(3);
    // Not a WAV at all.
    expect(parseWavHeader(new TextEncoder().encode("<?xml version="))).toBeNull();
  });
});

describe("wavDurationMs", () => {
  it("derives duration from the data size and byte rate", () => {
    const bytes = new Uint8Array(
      encodeWavPcm16Mono(new Float32Array(16000 * 2), 16000), // 2 seconds
    );
    const info = parseWavHeader(bytes);
    expect(info && wavDurationMs(info)).toBe(2000);
  });
});
