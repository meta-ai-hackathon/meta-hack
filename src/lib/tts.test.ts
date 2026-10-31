import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_TTS_VOICE,
  GEMINI_TTS_MODEL,
  GEMINI_TTS_URL,
  MAX_SPEAK_TEXT_LENGTH,
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
//
// Natural-conversation milestone (HACK-106): the model is the current
// Gemini 3.8 Flash TTS and the voice is the committed Callirrhoe prebuilt
// (chosen for naturalness; the old Kore default is cataloged as a firm,
// authoritative news voice — the "very AI" complaint). Gemini 3.8 treats
// the request text STRICTLY as a verbatim transcript, so the old
// "Read the following text…" prefix frame is GONE: a prefix would now be
// read aloud. Verbatim delivery is preserved by the model's own contract
// (the text field is spoken exactly as written — VAL-VOICE-003), and both
// model and voice are overridable via env without a second definition.

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
  delete process.env.GEMINI_TTS_VOICE;
  delete process.env.GEMINI_TTS_MODEL;
});

describe("speakText request shape", () => {
  it("posts the EXACT text as a verbatim transcript with the committed voice, keyed by x-goog-api-key", async () => {
    const { transport, calls } = scriptedTts([
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(240)) },
    ]);
    setTtsTransport(transport);

    await speakText("Thanks for telling me.");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(GEMINI_TTS_URL);
    expect(calls[0].url).toContain(`models/${GEMINI_TTS_MODEL}:generateContent`);
    expect(calls[0].headers["x-goog-api-key"]).toBe(SENTINEL_KEY);
    const body = JSON.parse(calls[0].body) as {
      contents: { parts: { text: string }[] }[];
      generationConfig: {
        responseModalities: string[];
        speechConfig: { voiceConfig: { voice: string } };
      };
    };
    // Verbatim transcript: the request text is the EXACT spoken text, with
    // no delivery prefix (a prefix would be read aloud on Gemini 3.8).
    expect(body.contents[0]?.parts[0]?.text).toBe("Thanks for telling me.");
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(body.generationConfig.speechConfig.voiceConfig.voice).toBe(
      DEFAULT_TTS_VOICE,
    );
  });

  it("keeps the committed identifiers in the one constants block (VAL-VTTS-001)", () => {
    // The PR records these exact identifiers as the shipped choice; if this
    // test fails, the voice/model was changed somewhere other than the
    // single constants block in tts.ts.
    expect(DEFAULT_TTS_VOICE).toBe("Callirrhoe");
    expect(GEMINI_TTS_MODEL).toBe("gemini-3.8-flash-tts");
  });

  it("honors the GEMINI_TTS_VOICE and GEMINI_TTS_MODEL env overrides", async () => {
    const { transport, calls } = scriptedTts([
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(240)) },
    ]);
    setTtsTransport(transport);
    process.env.GEMINI_TTS_VOICE = "Puck";
    process.env.GEMINI_TTS_MODEL = "gemini-3.8-flash-lite-tts";

    await speakText("Thanks for telling me.");

    expect(calls[0].url).toContain(
      "models/gemini-3.8-flash-lite-tts:generateContent",
    );
    const body = JSON.parse(calls[0].body) as {
      generationConfig: {
        speechConfig: { voiceConfig: { voice: string } };
      };
    };
    expect(body.generationConfig.speechConfig.voiceConfig.voice).toBe("Puck");

    // Blank overrides fall back to the constants.
    process.env.GEMINI_TTS_VOICE = "   ";
    delete process.env.GEMINI_TTS_MODEL;
    const second = scriptedTts([
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(240)) },
    ]);
    setTtsTransport(second.transport);
    await speakText("Thanks again.");
    const fallbackBody = JSON.parse(second.calls[0].body) as {
      generationConfig: {
        speechConfig: { voiceConfig: { voice: string } };
      };
    };
    expect(fallbackBody.generationConfig.speechConfig.voiceConfig.voice).toBe(
      DEFAULT_TTS_VOICE,
    );
    expect(second.calls[0].url).toContain(`models/${GEMINI_TTS_MODEL}:`);
  });

  it("property: for ANY text, either the exact text is posted verbatim (no prefix) or validation_error fires before any call", async () => {
    // Verbatim delivery is the load-bearing invariant (VAL-VOICE-003):
    // whatever the caller passes, the request text is exactly the trimmed
    // input — never a prefixed/prompted variant (a prefix would be read
    // aloud on Gemini 3.8) — and out-of-range text never reaches the
    // transport at all.
    const transcriptArb = fc
      .tuple(fc.string({ maxLength: MAX_SPEAK_TEXT_LENGTH + 8 }), fc.constantFrom("x", "y"))
      .map(([s, anchor]) => s + anchor);

    await fc.assert(
      fc.asyncProperty(transcriptArb, async (text) => {
        const trimmed = text.trim();
        const shouldCall = trimmed !== "" && trimmed.length <= MAX_SPEAK_TEXT_LENGTH;
        const { transport, calls } = scriptedTts([
          { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(48)) },
          { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(48)) },
        ]);
        setTtsTransport(transport);
        let rejection: { code: string } | null = null;
        try {
          await speakText(text);
        } catch (error) {
          rejection = error as { code: string };
        }
        if (shouldCall) {
          expect(rejection).toBeNull();
          expect(calls).toHaveLength(1);
          const body = JSON.parse(calls[0].body) as {
            contents: { parts: { text: string }[] }[];
          };
          expect(body.contents[0]?.parts[0]?.text).toBe(trimmed);
        } else {
          expect(rejection).toMatchObject({ code: "validation_error" });
          expect(calls).toHaveLength(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("property: blank env overrides always fall back to the constants; non-blank ones always win", async () => {
    const { transport, calls } = scriptedTts([
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(48)) },
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(48)) },
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(48)) },
      { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(48)) },
    ]);
    setTtsTransport(transport);

    const envValueArb = fc.oneof(
      // Blank (whitespace-only) — must resolve to the constants.
      fc.constantFrom(" ", "\t", "  \t ").map((ws) => ({ blank: true as const, ws })),
      // Non-blank — must resolve to the trimmed value.
      fc
        .tuple(fc.string({ maxLength: 40 }), fc.constantFrom("!", "1"))
        .map(([s, anchor]) => ({ blank: false as const, value: s + anchor })),
    );

    await fc.assert(
      fc.asyncProperty(envValueArb, async (voiceEnv) => {
        delete process.env.GEMINI_TTS_MODEL;
        const { transport: t, calls: cs } = scriptedTts([
          { body: geminiAudioBody("audio/L16;rate=24000", new Int16Array(48)) },
        ]);
        setTtsTransport(t);
        process.env.GEMINI_TTS_VOICE = voiceEnv.blank
          ? voiceEnv.ws
          : voiceEnv.value;

        await speakText("Hello.");

        expect(cs).toHaveLength(1);
        const body = JSON.parse(cs[0].body) as {
          generationConfig: { speechConfig: { voiceConfig: { voice: string } } };
        };
        const expected = voiceEnv.blank
          ? DEFAULT_TTS_VOICE
          : voiceEnv.value.trim();
        expect(body.generationConfig.speechConfig.voiceConfig.voice).toBe(expected);
      }),
      { numRuns: 60 },
    );
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
