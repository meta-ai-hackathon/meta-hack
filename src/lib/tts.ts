import { encodeWavPcm16Mono } from "./audio/wav";
import { AppError, logInfo, logWarn, userMessageFor } from "./telemetry";

// Spoken-reply client (Mission v2 M2). The Meta catalog has NO TTS model
// (live-verified), so the user steered spoken replies to an off-the-shelf
// service: Gemini's TTS model over plain REST. No SDK, no new dependency.
//
// Contract:
// - Key: GEMINI_API_KEY (never logged). Not configured → model_unavailable;
//   the client UI then falls back to browser speechSynthesis, so the
//   feature degrades instead of breaking.
// - Output: the API returns base64 inlineData audio. For gemini TTS that is
//   raw little-endian 16-bit PCM ("audio/L16;rate=24000") — wrapped here
//   into a canonical RIFF/WAVE file (the same encoder the browser capture
//   path uses). If a WAV mime type ever comes back, it passes through
//   untouched (never wrapped twice).
// - Failures map onto the closed taxonomy (429s → rate_limited, everything
//   else → model_unavailable) with timeout + bounded retries. Latency and
//   audio size are logged per call; the TEXT never is (it is assistant
//   output, but the log surface stays free of content regardless).

export const GEMINI_TTS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent";
export const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
/** A prebuilt Gemini voice; overridable per call. */
export const DEFAULT_TTS_VOICE = "Kore";
/**
 * The TTS model reads the prompt as speech direction; without a directive
 * frame it intermittently tries to answer in text (live-verified 400). The
 * committed prefix keeps delivery verbatim: the spoken reply is always the
 * EXACT subtitle text (VAL-VOICE-003).
 */
export const TTS_PROMPT_PREFIX =
  "Read the following text out loud exactly as written: ";
/** Assistant replies are short; this also bounds the unauthenticated route. */
export const MAX_SPEAK_TEXT_LENGTH = 1000;
/**
 * Live-verified: a cold first call can hang; the subtitle renders
 * immediately either way, so aborting a hung attempt at 10 s and retrying
 * (warm calls land in ~3 s) keeps the spoken-reply worst case acceptable.
 */
export const TTS_TIMEOUT_MS = 10_000;
export const TTS_MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 150;

export interface SpeakResult {
  /** Canonical RIFF/WAVE bytes, ready for an <audio> element. */
  readonly audio: Uint8Array;
  readonly contentType: "audio/wav";
  readonly latencyMs: number;
}

export interface TtsRequestInit {
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export type TtsTransport = (url: string, init: TtsRequestInit) => Promise<Response>;

const globalForTts = globalThis as unknown as {
  __benefitsNavigatorTtsTransport?: TtsTransport;
};

/** Inject a transport (tests); passing undefined restores the default. */
export function setTtsTransport(transport: TtsTransport | undefined): void {
  if (transport === undefined) {
    delete globalForTts.__benefitsNavigatorTtsTransport;
  } else {
    globalForTts.__benefitsNavigatorTtsTransport = transport;
  }
}

export function resetTtsTransport(): void {
  delete globalForTts.__benefitsNavigatorTtsTransport;
}

function activeTtsTransport(): TtsTransport {
  return globalForTts.__benefitsNavigatorTtsTransport ?? defaultTtsTransport;
}

function defaultTtsTransport(url: string, init: TtsRequestInit): Promise<Response> {
  return fetch(url, init);
}

/** Whether spoken replies via Gemini are configured (GEMINI_API_KEY set). */
export function isTtsConfigured(): boolean {
  return (
    typeof process.env.GEMINI_API_KEY === "string" &&
    process.env.GEMINI_API_KEY.trim() !== ""
  );
}

function ttsApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    throw new AppError(
      "model_unavailable",
      userMessageFor("model_unavailable"),
    );
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Parse "audio/L16;rate=24000" → 24000 (the documented Gemini TTS rate). */
function pcmRateFromMimeType(mimeType: string): number {
  const match = /rate=(\d+)/.exec(mimeType);
  return match ? Number(match[1]) : 24000;
}

/** Wrap raw little-endian int16 PCM in a canonical WAV container. */
function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return new Uint8Array(encodeWavPcm16Mono(samples, sampleRate));
}

/**
 * Speak one assistant reply: POST the text to Gemini TTS and return
 * canonical WAV bytes. Validation errors fire before any call; network and
 * server failures retry briefly, then map to the taxonomy.
 */
export async function speakText(
  text: string,
  voice: string = DEFAULT_TTS_VOICE,
): Promise<SpeakResult> {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > MAX_SPEAK_TEXT_LENGTH) {
    throw new AppError(
      "validation_error",
      userMessageFor("validation_error"),
      { cause: { textLength: trimmed.length } },
    );
  }
  const key = ttsApiKey();
  const body = JSON.stringify({
    contents: [{ parts: [{ text: `${TTS_PROMPT_PREFIX}${trimmed}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  });

  const started = Date.now();
  let exhaustedAs: "rate_limited" | "model_unavailable" = "model_unavailable";
  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt += 1) {
    const attemptStarted = Date.now();
    try {
      const response = await activeTtsTransport()(GEMINI_TTS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key,
        },
        body,
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });
      if (response.status === 429) {
        exhaustedAs = "rate_limited";
      } else if (!response.ok) {
        exhaustedAs = "model_unavailable";
      } else {
        const parsed = (await response.json()) as {
          candidates?: {
            content?: {
              parts?: {
                inlineData?: { mimeType?: string; data?: string };
              }[];
            };
          }[];
        };
        const part =
          parsed.candidates?.[0]?.content?.parts?.find?.(
            (candidate) => candidate?.inlineData?.data,
          ) ?? parsed.candidates?.[0]?.content?.parts?.[0];
        const data = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType ?? "";
        if (typeof data === "string" && data !== "") {
          const bytes = base64ToBytes(data);
          const audio =
            mimeType.toLowerCase().includes("wav")
              ? bytes
              : pcmToWav(bytes, pcmRateFromMimeType(mimeType));
          const latencyMs = Date.now() - attemptStarted;
          logInfo("model_tts_call", {
            model: GEMINI_TTS_MODEL,
            attempt,
            latencyMs,
            audioBytes: audio.byteLength,
            textLength: trimmed.length,
          });
          return { audio, contentType: "audio/wav", latencyMs };
        }
        exhaustedAs = "model_unavailable";
      }
    } catch {
      exhaustedAs = "model_unavailable";
    }
    if (attempt < TTS_MAX_ATTEMPTS) {
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  logWarn("model_tts_failed", {
    model: GEMINI_TTS_MODEL,
    attempts: TTS_MAX_ATTEMPTS,
    outcome: exhaustedAs,
    latencyMs: Date.now() - started,
  });
  throw new AppError(exhaustedAs, userMessageFor(exhaustedAs));
}
