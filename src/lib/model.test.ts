import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  CHAT_URL,
  MAX_AUDIO_BODY_BYTES,
  MIN_CHAT_MAX_TOKENS,
  STT_MODEL,
  STT_URL,
  chatCompletion,
  resetModelTransport,
  setModelTransport,
  transcribeAudio,
  type ChatMessage,
  type ModelTransport,
} from "./model";
import { AppError, setLogSink, type LogLine } from "./telemetry";

// Model client unit tests (Mission v2 M1): a scripted transport proves the
// request shape (pinned model, bearer auth from MODEL_API_KEY only, the
// >= 1024 completion budget), the retry/failure taxonomy, and the per-call
// usage logging contract (VAL-CONV-009) — with zero live network calls.

const SENTINEL_KEY = "sentinel-model-key-abc123";

interface RecordedCall {
  readonly url: string;
  readonly init: {
    method: string;
    headers: Record<string, string>;
    body: string | FormData;
  };
}

interface ScriptStep {
  readonly status?: number;
  readonly body?: unknown;
  readonly fail?: Error;
}

function completionBody(
  content: string | null,
  finishReason: string,
): unknown {
  return {
    id: "chatcmpl-test",
    model: CHAT_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: "assistant", content },
      },
    ],
    usage: {
      prompt_tokens: 13,
      completion_tokens: 148,
      total_tokens: 161,
      completion_tokens_details: { reasoning_tokens: 138 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

function scriptedTransport(
  steps: readonly ScriptStep[],
): { transport: ModelTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: ModelTransport = async (url, init) => {
    calls.push({
      url,
      init: {
        method: init.method,
        headers: init.headers,
        body: init.body,
      },
    });
    const step = steps[calls.length - 1];
    if (!step) {
      throw new Error("scripted transport queue exhausted");
    }
    if (step.fail) {
      throw step.fail;
    }
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { transport, calls };
}

function collectLogs(): LogLine[] {
  const lines: LogLine[] = [];
  setLogSink((line) => {
    lines.push(JSON.parse(line) as LogLine);
  });
  return lines;
}

const MESSAGES: readonly ChatMessage[] = [
  { role: "system", content: "You are a test assistant." },
  { role: "user", content: "Reply with exactly: OK" },
];

beforeEach(() => {
  process.env.MODEL_API_KEY = SENTINEL_KEY;
});

afterEach(() => {
  resetModelTransport();
  setLogSink(() => undefined);
  delete process.env.MODEL_API_KEY;
  delete process.env.META_API_KEY;
});

describe("chatCompletion request shape", () => {
  it("sends the pinned model, bearer auth, and a completion budget at or above the floor", async () => {
    const { transport, calls } = scriptedTransport([
      { body: completionBody("OK", "stop") },
    ]);
    setModelTransport(transport);

    const result = await chatCompletion(MESSAGES);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CHAT_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    const requestBody = JSON.parse(String(calls[0].init.body)) as {
      model: string;
      max_tokens: number;
      messages: unknown;
    };
    expect(requestBody.model).toBe(CHAT_MODEL);
    expect(requestBody.max_tokens).toBeGreaterThanOrEqual(MIN_CHAT_MAX_TOKENS);
    expect(requestBody.messages).toEqual(MESSAGES);
    expect(result.content).toBe("OK");
    expect(result.finishReason).toBe("stop");
  });

  it("never sends META_API_KEY material: a missing MODEL_API_KEY fails before any call", async () => {
    delete process.env.MODEL_API_KEY;
    process.env.META_API_KEY = "decoy-key-value";

    const { transport, calls } = scriptedTransport([
      { body: completionBody("OK", "stop") },
    ]);
    setModelTransport(transport);

    await expect(chatCompletion(MESSAGES)).rejects.toMatchObject({
      name: "AppError",
      code: "model_unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a sub-floor completion budget with validation_error before any call", async () => {
    const { transport, calls } = scriptedTransport([]);
    setModelTransport(transport);

    await expect(chatCompletion(MESSAGES, { maxTokens: 512 })).rejects.toMatchObject(
      { name: "AppError", code: "validation_error" },
    );
    expect(calls).toHaveLength(0);
  });
});

describe("chatCompletion usage logging (VAL-CONV-009)", () => {
  it("logs one model_chat_call line with usage and latency and never the key", async () => {
    const { transport, calls } = scriptedTransport([
      { body: completionBody("OK", "stop") },
    ]);
    setModelTransport(transport);
    const logs = collectLogs();

    await chatCompletion(MESSAGES);

    const callLines = logs.filter((line) => line.event === "model_chat_call");
    expect(callLines).toHaveLength(1);
    expect(callLines[0].level).toBe("info");
    expect(callLines[0].promptTokens).toBe(13);
    expect(callLines[0].completionTokens).toBe(148);
    expect(callLines[0].reasoningTokens).toBe(138);
    expect(callLines[0].totalTokens).toBe(161);
    expect(typeof callLines[0].latencyMs).toBe("number");
    expect(callLines[0].latencyMs).toBeGreaterThanOrEqual(0);
    // No key material in ANY log line, and no prompt or completion content.
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SENTINEL_KEY);
    expect(serialized).not.toContain("test assistant");
    expect(calls).toHaveLength(1);
  });
});

describe("chatCompletion retries and failure taxonomy", () => {
  it("retries a transient 429 and succeeds on a later attempt", async () => {
    const { transport, calls } = scriptedTransport([
      { status: 429, body: { error: { message: "slow down" } } },
      { body: completionBody("OK", "stop") },
    ]);
    setModelTransport(transport);

    const result = await chatCompletion(MESSAGES);

    expect(result.content).toBe("OK");
    expect(calls).toHaveLength(2);
  });

  it("retries a length-exhausted null-content response (the reasoning-budget gotcha)", async () => {
    const { transport, calls } = scriptedTransport([
      { body: completionBody(null, "length") },
      { body: completionBody("Recovered", "stop") },
    ]);
    setModelTransport(transport);

    const result = await chatCompletion(MESSAGES);

    expect(result.content).toBe("Recovered");
    expect(calls).toHaveLength(2);
  });

  it("maps exhausted 429s to the rate_limited taxonomy error", async () => {
    const { transport, calls } = scriptedTransport([
      { status: 429, body: {} },
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);
    setModelTransport(transport);

    const error = await chatCompletion(MESSAGES).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "AppError", code: "rate_limited" });
    expect(calls).toHaveLength(3);
  });

  it("maps exhausted server errors to model_unavailable", async () => {
    const { transport, calls } = scriptedTransport([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    setModelTransport(transport);

    const error = await chatCompletion(MESSAGES).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "model_unavailable" });
    expect(calls).toHaveLength(3);
  });

  it("maps exhausted network failures to model_unavailable", async () => {
    const { transport, calls } = scriptedTransport([
      { fail: new Error("socket hung up") },
      { fail: new Error("socket hung up") },
      { fail: new Error("socket hung up") },
    ]);
    setModelTransport(transport);

    const error = await chatCompletion(MESSAGES).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "model_unavailable" });
    expect(calls).toHaveLength(3);
  });

  it("maps persistently null-content responses to model_unavailable", async () => {
    const { transport, calls } = scriptedTransport([
      { body: completionBody(null, "length") },
      { body: completionBody(null, "length") },
      { body: completionBody(null, "length") },
    ]);
    setModelTransport(transport);

    const error = await chatCompletion(MESSAGES).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "model_unavailable" });
    expect(calls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Speech-to-text (Mission v2 M2): muse-voice-transcribe-1.0, multipart with
// exactly two parts, RIFF/WAVE mono 16-bit PCM 16/24 kHz ONLY (live-verified
// rejections), 32 MB body cap, 10-minute audio cap, taxonomy failures.
// ---------------------------------------------------------------------------

/** Build WAV bytes with full control over the header fields. */
function makeWav(options: {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  pcmFormat?: number;
  sampleCount?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const {
    sampleRate = 16000,
    channels = 1,
    bitsPerSample = 16,
    pcmFormat = 1,
    sampleCount = 160,
    payload,
  } = options;
  const dataBytes =
    payload !== undefined
      ? payload.byteLength
      : sampleCount * channels * (bitsPerSample / 8);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, pcmFormat, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  if (payload !== undefined) {
    bytes.set(payload, 44);
  }
  return bytes;
}

function sttResponseBody(transcript: string, audioDurationMs: number): unknown {
  return {
    sessionId: "meta-asr-session",
    transcript,
    audioDurationMs,
    turns: [],
  };
}

/** A scripted transport that records STT calls (the chat transport above records JSON bodies). */
function scriptedSttTransport(steps: readonly ScriptStep[]): {
  transport: ModelTransport;
  calls: { url: string; init: { headers: Record<string, string>; body: unknown } }[];
} {
  const calls: { url: string; init: { headers: Record<string, string>; body: unknown } }[] = [];
  const transport: ModelTransport = async (url, init) => {
    calls.push({ url, init: { headers: init.headers, body: init.body } });
    const step = steps[calls.length - 1];
    if (!step) {
      throw new Error("scripted STT transport queue exhausted");
    }
    if (step.fail) {
      throw step.fail;
    }
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { transport, calls };
}

const VALID_WAV = makeWav({ sampleCount: 16000 }); // one second at 16 kHz

describe("transcribeAudio request shape", () => {
  it("posts exactly two multipart parts to the STT endpoint with bearer auth and the session id", async () => {
    const { transport, calls } = scriptedSttTransport([
      { body: sttResponseBody("hello there", 1000) },
    ]);
    setModelTransport(transport);

    const result = await transcribeAudio(VALID_WAV, "session-abc");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${STT_URL}?sessionId=session-abc`);
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    // The multipart body carries NO content-type header of our own (fetch
    // must set the boundary).
    expect(calls[0].init.headers["content-type"]).toBeUndefined();
    const form = calls[0].init.body as FormData;
    const names = [...form.keys()].sort();
    expect(names).toEqual(["audio", "request"]); // exactly two parts
    const requestPart = form.get("request") as File;
    expect(requestPart.type).toBe("application/json");
    const request = JSON.parse(await requestPart.text()) as Record<string, unknown>;
    expect(request).toEqual({
      model: STT_MODEL,
      mode: "PUSH_TO_TALK",
      audioEncoding: "WAV",
      languageBias: ["English"],
    });
    const audioPart = form.get("audio") as File;
    expect(new Uint8Array(await audioPart.arrayBuffer())).toEqual(VALID_WAV);
    expect(result.transcript).toBe("hello there");
    expect(result.audioDurationMs).toBe(1000);
    expect(result.sessionId).toBe("meta-asr-session");
  });

  it("omits the session query param when no session exists yet", async () => {
    const { transport, calls } = scriptedSttTransport([
      { body: sttResponseBody("hi", 500) },
    ]);
    setModelTransport(transport);

    await transcribeAudio(VALID_WAV, null);
    expect(calls[0].url).toBe(STT_URL);
  });

  it("never reads META_API_KEY: a missing MODEL_API_KEY fails before any call", async () => {
    delete process.env.MODEL_API_KEY;
    process.env.META_API_KEY = "decoy-key-value";
    const { transport, calls } = scriptedSttTransport([]);
    setModelTransport(transport);

    await expect(transcribeAudio(VALID_WAV, null)).rejects.toMatchObject({
      name: "AppError",
      code: "model_unavailable",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("transcribeAudio audio format enforcement (VAL-VOICE-006)", () => {
  it("accepts 16 kHz and 24 kHz mono 16-bit PCM and rejects everything else before any call", async () => {
    const accepted = [
      makeWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }),
      makeWav({ sampleRate: 24000, channels: 1, bitsPerSample: 16 }),
    ];
    const rejected: [string, Uint8Array][] = [
      ["not a wav", new TextEncoder().encode("this is not audio at all")],
      ["stereo", makeWav({ channels: 2 })],
      ["8-bit", makeWav({ bitsPerSample: 8 })],
      ["44.1 kHz", makeWav({ sampleRate: 44100 })],
      ["float format", makeWav({ pcmFormat: 3 })],
      ["truncated", makeWav({ sampleCount: 1600 }).slice(0, 40)],
    ];
    for (const wav of accepted) {
      const { transport, calls } = scriptedSttTransport([
        { body: sttResponseBody("ok", 100) },
      ]);
      setModelTransport(transport);
      await expect(transcribeAudio(wav, null)).resolves.toBeDefined();
      expect(calls).toHaveLength(1);
    }
    for (const [label, wav] of rejected) {
      const { transport, calls } = scriptedSttTransport([
        { body: sttResponseBody("should never be reached", 0) },
      ]);
      setModelTransport(transport);
      const error = await transcribeAudio(wav, null).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, label).toMatchObject({ name: "AppError", code: "validation_error" });
      expect(calls, `${label}: no model call may fire`).toHaveLength(0);
    }
  });

  it("rejects an oversized body and an over-long recording before any call", async () => {
    const oversized = new Uint8Array(MAX_AUDIO_BODY_BYTES + 1);
    const oversizedTransport = scriptedSttTransport([]);
    setModelTransport(oversizedTransport.transport);
    await expect(transcribeAudio(oversized, null)).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(oversizedTransport.calls).toHaveLength(0);

    // 601 seconds of 16 kHz mono 16-bit audio exceeds the 10-minute cap.
    const longSeconds = 601;
    const longWav = new Uint8Array(44 + longSeconds * 32000);
    new DataView(longWav.buffer).setUint32(24, 16000, true);
    new DataView(longWav.buffer).setUint32(40, longSeconds * 32000, true);
    const longTransport = scriptedSttTransport([]);
    setModelTransport(longTransport.transport);
    await expect(transcribeAudio(longWav, null)).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(longTransport.calls).toHaveLength(0);
  });
});

describe("transcribeAudio retries, taxonomy, and usage logging", () => {
  it("retries a transient failure and logs one model_stt_call line with latency and duration", async () => {
    const { transport, calls } = scriptedSttTransport([
      { status: 503, body: {} },
      { body: sttResponseBody("the words", 2300) },
    ]);
    setModelTransport(transport);
    const logs = collectLogs();

    const result = await transcribeAudio(VALID_WAV, null);

    expect(result.transcript).toBe("the words");
    expect(calls).toHaveLength(2);
    const callLines = logs.filter((line) => line.event === "model_stt_call");
    expect(callLines).toHaveLength(1);
    expect(typeof callLines[0].latencyMs).toBe("number");
    expect(callLines[0].audioDurationMs).toBe(2300);
    // The transcript and the key never appear in any log line.
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("the words");
    expect(serialized).not.toContain(SENTINEL_KEY);
  });

  it("maps exhausted 429s to rate_limited and other failures to model_unavailable", async () => {
    const throttled = scriptedSttTransport([
      { status: 429, body: {} },
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);
    setModelTransport(throttled.transport);
    const error = await transcribeAudio(VALID_WAV, null).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "rate_limited" });
    expect(throttled.calls).toHaveLength(3);

    const down = scriptedSttTransport([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ]);
    setModelTransport(down.transport);
    const error2 = await transcribeAudio(VALID_WAV, null).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error2).toMatchObject({ code: "model_unavailable" });
  });

  it("treats a malformed success body as a transient failure and retries", async () => {
    const { transport, calls } = scriptedSttTransport([
      { body: { unexpected: "shape" } },
      { body: sttResponseBody("recovered", 100) },
    ]);
    setModelTransport(transport);

    const result = await transcribeAudio(VALID_WAV, null);
    expect(result.transcript).toBe("recovered");
    expect(calls).toHaveLength(2);
  });
});
