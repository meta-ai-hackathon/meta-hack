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
// - Output: the API returns base64 inlineData audio. Gemini 3.8 TTS returns
//   a complete WAV ("audio/wav", 24 kHz mono 16-bit PCM, RIFF header
//   included) on unary requests — passed through untouched. Headerless L16
//   PCM ("audio/L16;rate=24000", the older models' shape) is still wrapped
//   into a canonical RIFF/WAVE file (the same encoder the browser capture
//   path uses) so both response shapes stay playable.
// - Failures map onto the closed taxonomy (429s → rate_limited, everything
//   else → model_unavailable) with timeout + bounded retries. Latency and
//   audio size are logged per call; the TEXT never is (it is assistant
//   output, but the log surface stays free of content regardless).

/**
 * Spoken-reply model + voice (HACK-106, natural-conversation milestone):
 * Gemini 3.8 Flash TTS — Google's current maximum-fidelity TTS model
 * ("nuanced acting and expressive control" per the TTS docs, 2026-10-28
 * edition) — and the Callirrhoe prebuilt voice, chosen for naturalness
 * ("easy-going, relaxed, and casual … recommended for friendly guides",
 * Conversational / Companion-&-Peer persona). The shipped default Kore is
 * cataloged as "firm, direct, authoritative" — the "very AI" complaint.
 *
 * BOTH are defined HERE and nowhere else. The model names into the URL, so
 * one constant carries both; each can be overridden per environment
 * (GEMINI_TTS_MODEL / GEMINI_TTS_VOICE) without touching code — e.g. to
 * A/B a voice or roll back without a redeploy.
 *
 * Verbatim delivery (VAL-VOICE-003): Gemini 3.8 treats the request text
 * STRICTLY as a verbatim transcript — the old "Read the following text out
 * loud exactly as written: " prefix of the 2.5 model would now be READ
 * ALOUD, so it is gone; the text field carries the exact subtitle and the
 * model contract speaks it exactly as written.
 */
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
/** The committed prebuilt voice; overridable per environment. */
export const DEFAULT_TTS_VOICE = "Callirrhoe";

/** The configured voice: GEMINI_TTS_VOICE override, else the constant. */
export function configuredTtsVoice(): string {
  const override = process.env.GEMINI_TTS_VOICE;
  return override && override.trim() !== "" ? override.trim() : DEFAULT_TTS_VOICE;
}

/** The configured model: GEMINI_TTS_MODEL override, else the constant. */
export function configuredTtsModel(): string {
  const override = process.env.GEMINI_TTS_MODEL;
  return override && override.trim() !== "" ? override.trim() : GEMINI_TTS_MODEL;
}

/** The endpoint for the configured model (same shape as GEMINI_TTS_URL). */
export function configuredTtsUrl(): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${configuredTtsModel()}:generateContent`;
}
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
  voice: string = configuredTtsVoice(),
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
  // Gemini 3.8 contract: the text field is a STRICT verbatim transcript —
  // no delivery prefix, or the prefix itself would be read aloud. The
  // configured voice rides in speechConfig (single-speaker shape).
  const body = JSON.stringify({
    contents: [{ parts: [{ text: trimmed }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { voice },
      },
    },
  });

  const started = Date.now();
  let exhaustedAs: "rate_limited" | "model_unavailable" = "model_unavailable";
  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt += 1) {
    const attemptStarted = Date.now();
    try {
      const response = await activeTtsTransport()(configuredTtsUrl(), {
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
            model: configuredTtsModel(),
            voice,
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
    model: configuredTtsModel(),
    attempts: TTS_MAX_ATTEMPTS,
    outcome: exhaustedAs,
    latencyMs: Date.now() - started,
  });
  throw new AppError(exhaustedAs, userMessageFor(exhaustedAs));
}
