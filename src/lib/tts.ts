import { encodeWavPcm16Mono, parseWavHeader } from "./audio/wav";
import { AppError, logInfo, logWarn, userMessageFor } from "./telemetry";

// Spoken-reply client (Mission v2 M2; ElevenLabs switch, HACK-116,
// 2026-10-31). The Meta catalog has NO TTS model (live-verified), so the
// user steered spoken replies to an off-the-shelf service over plain REST.
// ElevenLabs replaces Gemini as the voice-out: the Gemini FREE TIER allowed
// 10 requests/DAY, overnight validation exhausted it, and the app silently
// fell back to the robotic OS browser voice — the root cause this switch
// removes (the client UI now also shows a visible fallback notice,
// VAL-TTS2-002). No SDK, no new dependency.
//
// Contract:
// - Key: ELEVENLABS_API_KEY (never logged). Not configured →
//   model_unavailable; the client UI then falls back to browser
//   speechSynthesis (with the visible notice), so the feature degrades
//   honestly instead of breaking.
// - Request: POST /v1/text-to-speech/{voice_id} with the `xi-api-key`
//   header and a { text, model_id } JSON body — the text is spoken
//   verbatim, so the payload carries the exact reply text and nothing else.
// - Output: the committed output format is pcm_24000 (raw PCM is
//   free-tier-safe; WAV-container output at 44.1 kHz is a Pro-tier format),
//   so the response bytes are wrapped into a canonical RIFF/WAVE file by
//   the same encoder the browser capture path uses. A response that is
//   already a complete WAV (RIFF sniff, content-based) passes through
//   untouched.
// - Failures map onto the closed taxonomy (429s → rate_limited, everything
//   else → model_unavailable) with timeout + bounded retries. Latency and
//   audio size are logged per call; the TEXT never is (it is assistant
//   output, but the log surface stays free of content regardless).

/**
 * Spoken-reply model + voice (HACK-116, tts-elevenlabs-switch):
 * `eleven_multilingual_v2` — chosen for QUALITY (warmest, most stable
 * naturalness; the demo complaint was the robotic OS voice, and the
 * replaced Gemini path already tolerated ~2.5-3.7 s, so multilingual v2's
 * higher latency versus Flash is an acceptable trade). Voice: "Sarah"
 * (EXAVITQu4vr4xnSDxMaL), ElevenLabs' flagship warm conversational premade
 * voice.
 *
 * ALL are defined HERE and nowhere else (VAL-TTS2-001). The model rides in
 * the request body's model_id and the voice in the URL path; each can be
 * overridden per environment (ELEVENLABS_TTS_MODEL / ELEVENLABS_TTS_VOICE)
 * without touching code — e.g. to A/B a voice or roll back without a
 * redeploy. The override takes the VOICE ID (the EX… form) — the endpoint
 * path does not accept display names.
 */
export const ELEVENLABS_TTS_MODEL = "eleven_multilingual_v2";
export const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
/** The committed premade voice ("Sarah"); overridable per environment. */
export const DEFAULT_TTS_VOICE = "EXAVITQu4vr4xnSDxMaL";
/**
 * The committed output format: raw PCM, free-tier-safe, wrapped into WAV
 * client-side. WAV-container output (wav_44100) is a Pro-tier format.
 */
export const DEFAULT_TTS_OUTPUT_FORMAT = "pcm_24000";

/** The configured voice: ELEVENLABS_TTS_VOICE override, else the constant. */
export function configuredTtsVoice(): string {
  const override = process.env.ELEVENLABS_TTS_VOICE;
  return override && override.trim() !== "" ? override.trim() : DEFAULT_TTS_VOICE;
}

/** The configured model: ELEVENLABS_TTS_MODEL override, else the constant. */
export function configuredTtsModel(): string {
  const override = process.env.ELEVENLABS_TTS_MODEL;
  return override && override.trim() !== "" ? override.trim() : ELEVENLABS_TTS_MODEL;
}

/** The endpoint for a voice id: base URL + voice path + the output format. */
export function configuredTtsUrl(voice: string = configuredTtsVoice()): string {
  return `${ELEVENLABS_TTS_URL}/${voice}?output_format=${DEFAULT_TTS_OUTPUT_FORMAT}`;
}
/** Assistant replies are short; this also bounds the unauthenticated route. */
export const MAX_SPEAK_TEXT_LENGTH = 1000;
/**
 * Live-verified on the replaced path: a cold first call can hang; the
 * subtitle renders immediately either way, so aborting a hung attempt at
 * 10 s and retrying keeps the spoken-reply worst case acceptable.
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

/** Whether spoken replies via ElevenLabs are configured (ELEVENLABS_API_KEY set). */
export function isTtsConfigured(): boolean {
  return (
    typeof process.env.ELEVENLABS_API_KEY === "string" &&
    process.env.ELEVENLABS_API_KEY.trim() !== ""
  );
}

function ttsApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
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

/** Parse "pcm_24000" → 24000 (the committed ElevenLabs PCM rate). */
function pcmRateFromOutputFormat(format: string): number {
  const match = /pcm_(\d+)/.exec(format);
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
 * Speak one assistant reply: POST the text to ElevenLabs and return
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
  // ElevenLabs contract: `text` is spoken verbatim — the payload carries
  // the exact reply text and nothing else (no delivery prefix, no framing);
  // the model rides in model_id, the voice in the URL path.
  const body = JSON.stringify({
    text: trimmed,
    model_id: configuredTtsModel(),
  });

  const started = Date.now();
  let exhaustedAs: "rate_limited" | "model_unavailable" = "model_unavailable";
  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt += 1) {
    const attemptStarted = Date.now();
    try {
      const response = await activeTtsTransport()(configuredTtsUrl(voice), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": key,
        },
        body,
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });
      if (response.status === 429) {
        exhaustedAs = "rate_limited";
      } else if (!response.ok) {
        exhaustedAs = "model_unavailable";
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 0) {
          // Headerless raw PCM (the pcm_24000 contract) is wrapped into a
          // canonical WAV; a complete WAV response passes through.
          const audio = parseWavHeader(bytes)
            ? bytes
            : pcmToWav(bytes, pcmRateFromOutputFormat(DEFAULT_TTS_OUTPUT_FORMAT));
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
