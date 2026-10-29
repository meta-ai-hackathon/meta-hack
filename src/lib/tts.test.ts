import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GEMINI_TTS_MODEL,
  GEMINI_TTS_URL,
  MAX_SPEAK_TEXT_LENGTH,
  TTS_PROMPT_PREFIX,
  isTtsConfigured,
  resetTtsTransport,
  setTtsTransport,
  speakText,
  type TtsTransport,
} from "./tts";
import { parseWavHeader, encodeWavPcm16Mono } from "./audio/wav";
import { setLogSink, type LogLine } from "./telemetry";

// Gemini spoken-reply client tests (Mission v2 M2). The user steered the
// voice stack to an off-the-shelf TTS (Gemini) instead of anything
// hand-rolled: a thin REST client behind an injectable transport, the same
// closed taxonomy as the Meta clients, and the spoken audio never carries
// text into logs. No key configured → callers fall back to browser
// speechSynthesis, so every test here runs CI-safe.

const SENTINEL_KEY = "sentinel-gemini-key-abc123";

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function geminiAudioBody(mimeType: string, pcm: Int16Array): unknown {
  // Base64 of little-endian int16 PCM, as the Gemini API returns inlineData.
  const bytes = new Uint8Array(pcm.buffer.slice(0));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return {
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType, data: btoa(binary) } }],
          role: "model",
        },
      },
    ],
  };
}

function scriptedTts(
  steps: { status?: number; body?: unknown; fail?: Error }[],
): { transport: TtsTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: TtsTransport = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: String(init.body),
    });
    const step = steps[calls.length - 1];
    if (!step) {
      throw new Error("scripted TTS transport queue exhausted");
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
  setLogSink((line) => lines.push(JSON.parse(line) as LogLine));
  return lines;
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = SENTINEL_KEY;
});

afterEach(() => {
  resetTtsTransport();
  setLogSink(() => undefined);
  delete process.env.GEMINI_API_KEY;
});

describe("speakText request shape", () => {
  it("posts the text with AUDIO modality and the prebuilt voice, keyed by x-goog-api-key", async () => {
    const { transport, calls } = scriptedTts([
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(240)) },
    ]);
    setTtsTransport(transport);

    await speakText("Thanks for telling me.");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(GEMINI_TTS_URL);
    expect(calls[0].headers["x-goog-api-key"]).toBe(SENTINEL_KEY);
    const body = JSON.parse(calls[0].body) as {
      contents: { parts: { text: string }[] }[];
      generationConfig: {
        responseModalities: string[];
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
      };
    };
    expect(body.contents[0]?.parts[0]?.text).toBe(
      `${TTS_PROMPT_PREFIX}Thanks for telling me.`,
    );
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(
      body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    ).toBeTypeOf("string");
  });
});

describe("speakText audio output", () => {
  it("wraps returned L16 PCM as a valid RIFF/WAVE 24 kHz mono file", async () => {
    const pcm = new Int16Array(24000); // one second
    const { transport } = scriptedTts([
      { body: geminiAudioBody("audio/L16;rate=24000", pcm) },
    ]);
    setTtsTransport(transport);

    const result = await speakText("One second of audio.");

    expect(result.contentType).toBe("audio/wav");
    const info = parseWavHeader(result.audio);
    expect(info).not.toBeNull();
    expect(info).toMatchObject({
      pcmFormat: 1,
      channels: 1,
      bitsPerSample: 16,
      sampleRate: 24000,
    });
  });

  it("passes a returned WAV through untouched", async () => {
    // If Gemini ever returns a wrapped WAV, the client must not wrap twice.
    const original = encodeWavPcm16Mono(new Float32Array(16), 24000);
    const bytes = new Uint8Array(original);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const { transport } = scriptedTts([
      {
        body: {
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: "audio/wav", data: btoa(binary) } },
                ],
                role: "model",
              },
            },
          ],
        },
      },
    ]);
    setTtsTransport(transport);

    const result = await speakText("hello");
    expect(new Uint8Array(result.audio)).toEqual(bytes);
  });
});

describe("speakText failure taxonomy and hygiene", () => {
  it("fails with model_unavailable before any call when no key is configured", async () => {
    delete process.env.GEMINI_API_KEY;
    const { transport, calls } = scriptedTts([]);
    setTtsTransport(transport);

    await expect(speakText("hello")).rejects.toMatchObject({
      name: "AppError",
      code: "model_unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports configuration through isTtsConfigured without touching META_API_KEY", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.META_API_KEY = "decoy-value";
    expect(isTtsConfigured()).toBe(false);
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    expect(isTtsConfigured()).toBe(true);
  });

  it("maps exhausted 429s to rate_limited and other failures to model_unavailable", async () => {
    const throttled = scriptedTts([
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);
    setTtsTransport(throttled.transport);
    await expect(speakText("hello")).rejects.toMatchObject({
      code: "rate_limited",
    });

    const down = scriptedTts([
      { status: 500, body: {} },
      { status: 500, body: {} },
    ]);
    setTtsTransport(down.transport);
    await expect(speakText("hello")).rejects.toMatchObject({
      code: "model_unavailable",
    });
  });

  it("rejects empty and oversized text with validation_error before any call", async () => {
    const { transport, calls } = scriptedTts([]);
    setTtsTransport(transport);
    await expect(speakText("   ")).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(
      speakText("a".repeat(MAX_SPEAK_TEXT_LENGTH + 1)),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(calls).toHaveLength(0);
  });

  it("never logs the spoken text or the key", async () => {
    const { transport } = scriptedTts([
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(48)) },
    ]);
    setTtsTransport(transport);
    const logs = collectLogs();

    await speakText("super secret sentence content");

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("super secret sentence content");
    expect(serialized).not.toContain(SENTINEL_KEY);
    const callLines = logs.filter((line) => line.event === "model_tts_call");
    expect(callLines).toHaveLength(1);
    expect(typeof callLines[0].latencyMs).toBe("number");
  });
});
