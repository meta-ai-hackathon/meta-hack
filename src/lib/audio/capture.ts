import { encodeWavPcm16Mono } from "./wav";

// Browser capture pipeline (Mission v2 M2): microphone → MediaRecorder →
// decode + downsample → 16 kHz mono 16-bit PCM WAV. Runs ENTIRELY in the
// browser — Vercel serverless has no ffmpeg, and the Meta STT endpoint
// accepts only this one WAV shape (live-verified).

/** The sample rate the Meta STT endpoint accepts (16 or 24 kHz; we encode 16). */
export const TARGET_SAMPLE_RATE = 16000;

/** Preferred recording mime types, best first (Safari falls back to mp4). */
const RECORD_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

/**
 * Pick the first MediaRecorder mime type the browser actually supports.
 * Pure in the predicate, so tests inject isTypeSupported.
 */
export function pickRecorderMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string | null {
  for (const candidate of RECORD_MIME_CANDIDATES) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

interface OfflineAudioContextLike {
  createBufferSource(): {
    buffer: unknown;
    connect(destination: unknown): void;
    start(): void;
  };
  readonly destination: unknown;
  startRendering(): Promise<AudioBuffer>;
}

interface WindowWithAudio {
  AudioContext?: new (options?: { sampleRate?: number }) => {
    decodeAudioData(buffer: ArrayBuffer): Promise<AudioBuffer>;
    close(): Promise<void>;
  };
  webkitAudioContext?: new (options?: { sampleRate?: number }) => {
    decodeAudioData(buffer: ArrayBuffer): Promise<AudioBuffer>;
    close(): Promise<void>;
  };
  OfflineAudioContext?: new (
    channels: number,
    length: number,
    sampleRate: number,
  ) => OfflineAudioContextLike;
  webkitOfflineAudioContext?: new (
    channels: number,
    length: number,
    sampleRate: number,
  ) => OfflineAudioContextLike;
}

/**
 * Decode a recorded blob (webm/opus or mp4/AAC) and render it as 16 kHz
 * mono, then encode 16-bit PCM WAV. The OfflineAudioContext downmixes
 * stereo and resamples in one render — no hand-rolled resampler.
 */
export async function recordedBlobToWav(blob: Blob): Promise<Blob> {
  const audioWindow = window as unknown as WindowWithAudio;
  const AudioCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  const OfflineCtor =
    audioWindow.OfflineAudioContext ?? audioWindow.webkitOfflineAudioContext;
  if (!AudioCtor || !OfflineCtor) {
    throw new Error("Web Audio API is not available in this browser");
  }
  // decodeAudioData detaches its buffer, so hand it a private copy.
  const copy = await blob.arrayBuffer();
  const decodeContext = new AudioCtor();
  try {
    const decoded = await decodeContext.decodeAudioData(copy);
    const length = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
    const offline = new OfflineCtor(1, length, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const wav = encodeWavPcm16Mono(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
    return new Blob([wav], { type: "audio/wav" });
  } finally {
    await decodeContext.close().catch(() => undefined);
  }
}

/**
 * Queue one spoken reply through browser speechSynthesis (the no-TTS-model
 * fallback path). Returns false — the caller then falls back to subtitles
 * only — when speechSynthesis is unavailable. The utterance speaks the
 * EXACT subtitle text (VAL-VOICE-003).
 */
export function queueSpeech(
  text: string,
  speechSynthesis?: {
    speak(utterance: { text: string }): void;
  } | null,
): boolean {
  const synth = speechSynthesis ?? window.speechSynthesis;
  if (!synth || typeof window.SpeechSynthesisUtterance === "undefined") {
    return false;
  }
  synth.speak(new window.SpeechSynthesisUtterance(text));
  return true;
}
