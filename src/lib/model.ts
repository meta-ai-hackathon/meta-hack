import { parseWavHeader, wavDurationMs } from "./audio/wav";
import { AppError, logInfo, logWarn, userMessageFor } from "./telemetry";

// Model client (Mission v2 M1): the app's first server-side Meta model
// client, for chat completions on muse-spark-1.3.
//
// Contract:
// - Key material comes from MODEL_API_KEY — the ONLY valid name. META_API_KEY
//   exists in some environments but is EMPTY there; reading it yields 401s,
//   so this module never touches it. The key is never logged or echoed.
// - Every call sets max_tokens >= 1024: completion tokens INCLUDE reasoning
//   tokens (live-verified — smaller budgets intermittently return
//   content: null with finish_reason: "length").
// - Timeout + bounded retries with backoff; a length-exhausted null-content
//   response is retried like any other transient failure.
// - Failures map onto the closed telemetry taxonomy: exhausted 429s are
//   rate_limited, everything else is model_unavailable. Callers degrade
//   honestly instead of fabricating output.
// - Per-call usage logging (prompt/completion/reasoning tokens, latency) via
//   telemetry — content and key material never.
//
// Mission v2 M2 adds the speech-to-text client (muse-voice-transcribe-1.0)
// with the live-verified request contract: multipart with exactly two parts
// (a `request` JSON part and an `audio` part), RIFF/WAVE mono 16-bit PCM at
// 16 or 24 kHz ONLY — everything else is rejected here, before any model
// call, with a taxonomy validation_error.

export const CHAT_URL = "https://api.meta.ai/v1/chat/completions";
export const CHAT_MODEL = "muse-spark-1.3";

/**
 * The floor for every chat call. Reasoning tokens consume the completion
 * budget; a trivial prompt can burn ~140 of them before answering.
 */
export const MIN_CHAT_MAX_TOKENS = 1024;
export const DEFAULT_CHAT_MAX_TOKENS = 1024;
export const CHAT_TIMEOUT_MS = 20_000;
export const CHAT_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 150;

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export interface ChatCallOptions {
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export interface ChatCallResult {
  readonly content: string;
  readonly finishReason: string;
  readonly model: string;
  readonly usage: ChatUsage;
  readonly latencyMs: number;
}

export interface ModelRequestInit {
  readonly method: "POST";
  readonly headers: Record<string, string>;
  /** JSON string for chat calls; FormData (two parts) for STT. */
  readonly body: string | FormData;
  readonly signal: AbortSignal;
}

/** The transport chatCompletion speaks through; tests inject a scripted one. */
export type ModelTransport = (
  url: string,
  init: ModelRequestInit,
) => Promise<Response>;

const globalForModel = globalThis as unknown as {
  __benefitsNavigatorModelTransport?: ModelTransport;
};

/** Inject a transport (tests): replaces the default network fetch transport. Passing undefined restores the default. */
export function setModelTransport(
  transport: ModelTransport | undefined,
): void {
  if (transport === undefined) {
    delete globalForModel.__benefitsNavigatorModelTransport;
  } else {
    globalForModel.__benefitsNavigatorModelTransport = transport;
  }
}

/** Restore the default network transport. */
export function resetModelTransport(): void {
  delete globalForModel.__benefitsNavigatorModelTransport;
}

function activeTransport(): ModelTransport {
  return globalForModel.__benefitsNavigatorModelTransport ?? defaultTransport;
}

function defaultTransport(url: string, init: ModelRequestInit): Promise<Response> {
  return fetch(url, init);
}

/**
 * Resolve the API key. MODEL_API_KEY is the only valid name — META_API_KEY
 * is empty by design in environments that carry both, so it is never read.
 * A missing key is a model_unavailable condition: callers degrade to the
 * honest error path instead of attempting an unauthenticated call.
 */
function modelApiKey(): string {
  const key = process.env.MODEL_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    throw new AppError(
      "model_unavailable",
      userMessageFor("model_unavailable"),
    );
  }
  return key;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function parseUsage(raw: unknown): ChatUsage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  }
  const record = raw as Record<string, unknown>;
  const details = record.completion_tokens_details;
  const detailRecord =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {};
  return {
    promptTokens: asCount(record.prompt_tokens),
    completionTokens: asCount(record.completion_tokens),
    reasoningTokens: asCount(detailRecord.reasoning_tokens),
    totalTokens: asCount(record.total_tokens),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run one chat completion with timeout, bounded retries, taxonomy mapping,
 * and per-call usage logging. Throws AppError("rate_limited") when every
 * attempt was 429-throttled, AppError("model_unavailable") for every other
 * exhaustion (network, 5xx, missing key, null content), and
 * AppError("validation_error") when a caller requests a sub-floor budget.
 */
export async function chatCompletion(
  messages: readonly ChatMessage[],
  options: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const maxTokens = options.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS;
  if (maxTokens < MIN_CHAT_MAX_TOKENS) {
    throw new AppError(
      "validation_error",
      userMessageFor("validation_error"),
      { cause: { maxTokens } },
    );
  }
  const key = modelApiKey();
  const timeoutMs = options.timeoutMs ?? CHAT_TIMEOUT_MS;
  const body = JSON.stringify({
    model: CHAT_MODEL,
    messages,
    max_tokens: maxTokens,
  });
  const started = Date.now();
  // The taxonomy code for exhaustion: rate_limited only when EVERY attempt
  // was throttled; any other failure mode is model_unavailable.
  let exhaustedAs: "rate_limited" | "model_unavailable" = "model_unavailable";

  for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt += 1) {
    const attemptStarted = Date.now();
    try {
      const response = await activeTransport()(CHAT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 429) {
        exhaustedAs = "rate_limited";
      } else if (!response.ok) {
        exhaustedAs = "model_unavailable";
      } else {
        const parsed = (await response.json()) as Record<string, unknown>;
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const first =
          choices.length > 0 && choices[0] && typeof choices[0] === "object"
            ? (choices[0] as Record<string, unknown>)
            : undefined;
        const message =
          first?.message &&
          typeof first.message === "object" &&
          !Array.isArray(first.message)
            ? (first.message as Record<string, unknown>)
            : undefined;
        const content =
          typeof message?.content === "string" ? message.content : null;
        const finishReason =
          typeof first?.finish_reason === "string"
            ? first.finish_reason
            : "";
        if (content !== null && content.trim() !== "") {
          const usage = parseUsage(parsed.usage);
          const latencyMs = Date.now() - attemptStarted;
          logInfo("model_chat_call", {
            model: CHAT_MODEL,
            attempt,
            finishReason,
            latencyMs,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            reasoningTokens: usage.reasoningTokens,
            totalTokens: usage.totalTokens,
          });
          return {
            content,
            finishReason,
            model: CHAT_MODEL,
            usage,
            latencyMs,
          };
        }
        // Null/empty content: the live-verified reasoning-budget gotcha —
        // a reasoning burst consumed the whole budget. Retry like any
        // transient failure.
        exhaustedAs = "model_unavailable";
      }
    } catch {
      exhaustedAs = "model_unavailable";
    }
    if (attempt < CHAT_MAX_ATTEMPTS) {
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  logWarn("model_chat_failed", {
    model: CHAT_MODEL,
    attempts: CHAT_MAX_ATTEMPTS,
    outcome: exhaustedAs,
    latencyMs: Date.now() - started,
  });
  throw new AppError(exhaustedAs, userMessageFor(exhaustedAs));
}

// ---------------------------------------------------------------------------
// Speech-to-text (Mission v2 M2)
// ---------------------------------------------------------------------------

export const STT_URL = "https://api.meta.ai/v1/asr/transcribe";
export const STT_MODEL = "muse-voice-transcribe-1.0";
export const STT_TIMEOUT_MS = 20_000;
export const STT_MAX_ATTEMPTS = 3;

/** Live-verified request-body cap (413 above it). */
export const MAX_AUDIO_BODY_BYTES = 32 * 1024 * 1024;
/** Live-verified audio-length cap (400 above it). */
export const MAX_AUDIO_DURATION_MS = 10 * 60 * 1000;
/** Live-verified: only these sample rates are accepted. */
export const ALLOWED_WAV_SAMPLE_RATES: readonly number[] = [16000, 24000];

export interface SttResult {
  /** The ASR session id echoed back, when one was sent. */
  readonly sessionId: string | null;
  readonly transcript: string;
  readonly audioDurationMs: number;
  readonly latencyMs: number;
}

function validationErrorWith(cause: Record<string, unknown>): AppError {
  return new AppError(
    "validation_error",
    userMessageFor("validation_error"),
    { cause },
  );
}

/**
 * Enforce the live-verified audio contract BEFORE any model call: a
 * RIFF/WAVE file, integer PCM, mono, 16-bit, 16 or 24 kHz, within the size
 * and duration caps. Anything else is a taxonomy validation_error — a wrong
 * upload is a 400, never a wasted model call.
 */
export function assertAcceptedAudioFormat(audio: Uint8Array): void {
  if (audio.byteLength > MAX_AUDIO_BODY_BYTES) {
    throw validationErrorWith({ reason: "audio_too_large", bytes: audio.byteLength });
  }
  if (audio.byteLength < 44) {
    throw validationErrorWith({ reason: "audio_not_wav" });
  }
  const info = parseWavHeader(audio);
  if (!info) {
    throw validationErrorWith({ reason: "audio_not_wav" });
  }
  if (info.pcmFormat !== 1) {
    throw validationErrorWith({ reason: "audio_not_pcm", pcmFormat: info.pcmFormat });
  }
  if (info.channels !== 1) {
    throw validationErrorWith({ reason: "audio_not_mono", channels: info.channels });
  }
  if (info.bitsPerSample !== 16) {
    throw validationErrorWith({ reason: "audio_not_16bit", bitsPerSample: info.bitsPerSample });
  }
  if (!ALLOWED_WAV_SAMPLE_RATES.includes(info.sampleRate)) {
    throw validationErrorWith({ reason: "audio_sample_rate", sampleRate: info.sampleRate });
  }
  if (wavDurationMs(info) > MAX_AUDIO_DURATION_MS) {
    throw validationErrorWith({
      reason: "audio_too_long",
      durationMs: Math.round(wavDurationMs(info)),
    });
  }
}

/**
 * Transcribe one spoken turn (PUSH_TO_TALK): validate the WAV, then POST
 * multipart with exactly two parts — the `request` JSON part and the
 * `audio` part — to /v1/asr/transcribe. Retries and taxonomy mapping mirror
 * chatCompletion; per-call usage (latency, audio duration) is logged, the
 * transcript and key material never are.
 */
export async function transcribeAudio(
  audio: Uint8Array,
  sessionId: string | null,
): Promise<SttResult> {
  // Enforcement runs before the key check so a bad upload never burns
  // anything — and before ANY network attempt.
  assertAcceptedAudioFormat(audio);
  const key = modelApiKey();

  const requestJson = JSON.stringify({
    model: STT_MODEL,
    mode: "PUSH_TO_TALK",
    audioEncoding: "WAV",
    languageBias: ["English"],
  });
  const form = new FormData();
  form.append(
    "request",
    new Blob([requestJson], { type: "application/json" }),
    "request.json",
  );
  form.append(
    "audio",
    new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
    "audio.wav",
  );
  const url = sessionId
    ? `${STT_URL}?sessionId=${encodeURIComponent(sessionId)}`
    : STT_URL;

  const started = Date.now();
  let exhaustedAs: "rate_limited" | "model_unavailable" = "model_unavailable";
  for (let attempt = 1; attempt <= STT_MAX_ATTEMPTS; attempt += 1) {
    const attemptStarted = Date.now();
    try {
      const response = await activeTransport()(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });
      if (response.status === 429) {
        exhaustedAs = "rate_limited";
      } else if (!response.ok) {
        exhaustedAs = "model_unavailable";
      } else {
        const parsed = (await response.json()) as Record<string, unknown>;
        const transcript =
          typeof parsed.transcript === "string" ? parsed.transcript : null;
        if (transcript !== null) {
          const audioDurationMs =
            typeof parsed.audioDurationMs === "number" &&
            Number.isFinite(parsed.audioDurationMs)
              ? parsed.audioDurationMs
              : 0;
          const latencyMs = Date.now() - attemptStarted;
          logInfo("model_stt_call", {
            model: STT_MODEL,
            attempt,
            latencyMs,
            audioDurationMs,
            audioBytes: audio.byteLength,
          });
          return {
            sessionId:
              typeof parsed.sessionId === "string" ? parsed.sessionId : null,
            transcript,
            audioDurationMs,
            latencyMs,
          };
        }
        exhaustedAs = "model_unavailable";
      }
    } catch {
      exhaustedAs = "model_unavailable";
    }
    if (attempt < STT_MAX_ATTEMPTS) {
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  logWarn("model_stt_failed", {
    model: STT_MODEL,
    attempts: STT_MAX_ATTEMPTS,
    outcome: exhaustedAs,
    latencyMs: Date.now() - started,
    audioBytes: audio.byteLength,
  });
  throw new AppError(exhaustedAs, userMessageFor(exhaustedAs));
}
