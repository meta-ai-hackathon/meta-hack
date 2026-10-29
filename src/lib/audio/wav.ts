// WAV codec (Mission v2 M2): the one piece of audio plumbing the voice mode
// needs, shared by the browser (encode) and the server (validate).
//
// Why in-browser: Vercel serverless has no ffmpeg, so the MediaRecorder blob
// (webm/opus, or mp4/AAC on Safari) is decoded and downsampled IN THE BROWSER
// to 16 kHz mono 16-bit PCM WAV before upload — the only encoding the Meta
// STT endpoint accepts (live-verified).
//
// Why a shared parser: the server enforces the same contract on the bytes it
// receives (format, channels, bit depth, sample rate, size, duration) BEFORE
// any model call, so a wrong upload is a 400, never a wasted call.

/** Parsed RIFF/WAVE facts the codec's callers need. */
export interface WavInfo {
  /** Wave format code: 1 = integer PCM (the only encoding we accept). */
  readonly pcmFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  /** Size of the data chunk payload, as claimed by the header. */
  readonly dataBytes: number;
  /** Byte offset of the first data sample. */
  readonly dataOffset: number;
}

const MAX_RIFF_CHUNKS = 32;

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return text;
}

/**
 * Parse a RIFF/WAVE header, walking chunks (real encoders — afconvert,
 * Safari's mp4-to-wav tools — prepend LIST/metadata chunks before fmt/data).
 * Returns null for anything that is not a structurally sound WAV whose data
 * chunk the available bytes actually carry; the caller judges whether the
 * reported format/channels/rate are acceptable.
 */
export function parseWavHeader(bytes: Uint8Array): WavInfo | null {
  if (bytes.byteLength < 12) {
    return null;
  }
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt: {
    pcmFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let data: { dataBytes: number; dataOffset: number } | null = null;

  for (
    let chunks = 0;
    chunks < MAX_RIFF_CHUNKS && offset + 8 <= bytes.byteLength;
    chunks += 1
  ) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    if (id === "fmt " && payloadOffset + 16 <= bytes.byteLength) {
      fmt = {
        pcmFormat: view.getUint16(payloadOffset, true),
        channels: view.getUint16(payloadOffset + 2, true),
        sampleRate: view.getUint32(payloadOffset + 4, true),
        bitsPerSample: view.getUint16(payloadOffset + 14, true),
      };
    } else if (id === "data") {
      const available = bytes.byteLength - payloadOffset;
      if (size > available) {
        // The header claims more audio than the bytes carry: truncated.
        return null;
      }
      data = { dataBytes: size, dataOffset: payloadOffset };
    }
    offset = payloadOffset + size + (size % 2); // chunks are word-aligned
    if (fmt && data) {
      return { ...fmt, ...data };
    }
  }
  return null;
}

/** Duration in milliseconds implied by a parsed header's data chunk. */
export function wavDurationMs(info: WavInfo): number {
  const bytesPerSample = info.channels * (info.bitsPerSample / 8);
  if (info.sampleRate <= 0 || bytesPerSample <= 0) {
    return 0;
  }
  return (info.dataBytes / (info.sampleRate * bytesPerSample)) * 1000;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Encode mono float samples as a canonical 44-byte-header 16-bit PCM WAV.
 * Samples are clamped to [-1, 1]. Runs in the browser (after the
 * OfflineAudioContext downsample) and in Node (tests, fixtures).
 */
export function encodeWavPcm16Mono(
  samples: Float32Array,
  sampleRate: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // integer PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(
      44 + i * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }
  return buffer;
}
