import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_TTS_VOICE,
  ELEVENLABS_TTS_MODEL,
  ELEVENLABS_TTS_URL,
  MAX_SPEAK_TEXT_LENGTH,
  isTtsConfigured,
  resetTtsTransport,
  setTtsTransport,
  speakText,
  type TtsTransport,
} from "./tts";
import { parseWavHeader, encodeWavPcm16Mono } from "./audio/wav";
import { setLogSink, type LogLine } from "./telemetry";

// ElevenLabs spoken-reply client tests (tts-elevenlabs-switch, HACK-116).
// The voice stack stays an off-the-shelf TTS behind an injectable transport
// with the same closed taxonomy as the Meta clients — the provider is now
// ElevenLabs (owner-directed 2026-10-31): the Gemini free tier allowed only
// 10 requests/DAY, and when it ran out the app SILENTLY fell back to the
// robotic OS browser voice (the bug this switch fixes; the client now shows
// a visible fallback notice — VAL-TTS2-002). No key configured → callers
// fall back to browser speechSynthesis, so every test here runs CI-safe
// with a fake transport — no real key needed (VAL-TTS2-004).
//
// ElevenLabs REST contract (live docs, 2026-10-31): POST
// /v1/text-to-speech/{voice_id} with the `xi-api-key` header and a
// { text, model_id } JSON body; `text` is spoken verbatim. The committed
// pcm_24000 output format responds with RAW PCM bytes (no container), so
// the client wraps them into a canonical RIFF/WAVE file; a response that
// is already a complete WAV passes through untouched.

const SENTINEL_KEY = "sentinel-elevenlabs-key-abc123";

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** ElevenLabs pcm output responds with RAW little-endian int16 PCM bytes. */
function pcmBytes(sampleCount: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(sampleCount * 2);
  new Int16Array(buffer); // zero-filled
  return new Uint8Array(buffer);
}

function scriptedTts(
  steps: { status?: number; body?: BodyInit; fail?: Error }[],
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
    return new Response(step.body ?? pcmBytes(48), {
      status: step.status ?? 200,
      headers: { "content-type": "application/octet-stream" },
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
  process.env.ELEVENLABS_API_KEY = SENTINEL_KEY;
});

afterEach(() => {
  resetTtsTransport();
  setLogSink(() => undefined);
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_TTS_VOICE;
  delete process.env.ELEVENLABS_TTS_MODEL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.META_API_KEY;
});

describe("speakText request shape", () => {
  it("posts the EXACT text with the committed model to the voice-id URL, keyed by xi-api-key", async () => {
    const { transport, calls } = scriptedTts([{}]);
    setTtsTransport(transport);

    await speakText("Thanks for telling me.");

    expect(calls).toHaveLength(1);
    // The voice rides in the URL path; the endpoint is the ElevenLabs REST
    // API (plain fetch, no SDK) at the committed pcm output format.
    expect(calls[0].url).toBe(
      `${ELEVENLABS_TTS_URL}/${DEFAULT_TTS_VOICE}?output_format=pcm_24000`,
    );
    expect(calls[0].headers["xi-api-key"]).toBe(SENTINEL_KEY);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    const body = JSON.parse(calls[0].body) as { text: string; model_id: string };
    // Verbatim payload: the request text is the EXACT spoken text, with
    // no delivery prefix and no framing (a prefix would be read aloud).
    expect(body.text).toBe("Thanks for telling me.");
    expect(body.model_id).toBe(ELEVENLABS_TTS_MODEL);
  });

  it("keeps the committed identifiers in the one constants block (VAL-TTS2-001)", () => {
    // The PR records these exact identifiers as the shipped choice; if this
    // test fails, the voice/model was changed somewhere other than the
    // single constants block in tts.ts. Model: eleven_multilingual_v2 —
    // chosen for QUALITY (the demo complaint was the robotic OS voice, and
    // the replaced Gemini path already tolerated ~2.5-3.7 s, so multilingual
    // v2's higher latency vs Flash is an acceptable trade). Voice: "Sarah"
    // (EXAVITQu4vr4xnSDxMaL), the warm flagship conversational premade
    // voice — the endpoint carries the voice_id, never the display name.
    expect(ELEVENLABS_TTS_MODEL).toBe("eleven_multilingual_v2");
    expect(DEFAULT_TTS_VOICE).toBe("EXAVITQu4vr4xnSDxMaL");
    expect(ELEVENLABS_TTS_URL).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech",
    );
  });

  it("honors the ELEVENLABS_TTS_VOICE and ELEVENLABS_TTS_MODEL env overrides", async () => {
    const { transport, calls } = scriptedTts([{}]);
    setTtsTransport(transport);
    process.env.ELEVENLABS_TTS_VOICE = "voice-id-override";
    process.env.ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";

    await speakText("Thanks for telling me.");

    // The override voice rides in the URL path, the override model in the
    // body — both resolvable without touching code.
    expect(calls[0].url).toContain("/voice-id-override?");
    expect(calls[0].url).not.toContain(DEFAULT_TTS_VOICE);
    const body = JSON.parse(calls[0].body) as { text: string; model_id: string };
    expect(body.model_id).toBe("eleven_flash_v2_5");

    // Blank overrides fall back to the constants.
    process.env.ELEVENLABS_TTS_VOICE = "   ";
    delete process.env.ELEVENLABS_TTS_MODEL;
    const second = scriptedTts([{}]);
    setTtsTransport(second.transport);
    await speakText("Thanks again.");
    expect(second.calls[0].url).toContain(`/${DEFAULT_TTS_VOICE}?`);
    const fallbackBody = JSON.parse(second.calls[0].body) as {
      model_id: string;
    };
    expect(fallbackBody.model_id).toBe(ELEVENLABS_TTS_MODEL);
  });

  it("property: for ANY text, either the exact text is posted verbatim (no prefix) or validation_error fires before any call", async () => {
    // Verbatim delivery is the load-bearing invariant (VAL-VOICE-003):
    // whatever the caller passes, the request text is exactly the trimmed
    // input — never a prefixed/prompted variant — and out-of-range text
    // never reaches the transport at all.
    const transcriptArb = fc
      .tuple(fc.string({ maxLength: MAX_SPEAK_TEXT_LENGTH + 8 }), fc.constantFrom("x", "y"))
      .map(([s, anchor]) => s + anchor);

    await fc.assert(
      fc.asyncProperty(transcriptArb, async (text) => {
        const trimmed = text.trim();
        const shouldCall = trimmed !== "" && trimmed.length <= MAX_SPEAK_TEXT_LENGTH;
        const { transport, calls } = scriptedTts([{}, {}]);
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
          const body = JSON.parse(calls[0].body) as { text: string };
          expect(body.text).toBe(trimmed);
        } else {
          expect(rejection).toMatchObject({ code: "validation_error" });
          expect(calls).toHaveLength(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("property: blank env overrides always fall back to the constants; non-blank ones always win", async () => {
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
        delete process.env.ELEVENLABS_TTS_MODEL;
        const { transport, calls } = scriptedTts([{}]);
        setTtsTransport(transport);
        process.env.ELEVENLABS_TTS_VOICE = voiceEnv.blank
          ? voiceEnv.ws
          : voiceEnv.value;

        await speakText("Hello.");

        expect(calls).toHaveLength(1);
        const expected = voiceEnv.blank
          ? DEFAULT_TTS_VOICE
          : voiceEnv.value.trim();
        expect(calls[0].url).toContain(`/${expected}?`);
      }),
      { numRuns: 60 },
    );
  });
});

describe("speakText audio output", () => {
  it("wraps returned raw PCM as a valid RIFF/WAVE 24 kHz mono file", async () => {
    const { transport } = scriptedTts([{ body: pcmBytes(24000) }]); // one second
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
    // If the endpoint ever returns a wrapped WAV, the client must not wrap
    // twice — the sniff is content-based (RIFF header), not content-type.
    const original = encodeWavPcm16Mono(new Float32Array(16), 24000);
    const bytes = new Uint8Array(original);
    const { transport } = scriptedTts([{ body: bytes }]);
    setTtsTransport(transport);

    const result = await speakText("hello");
    expect(new Uint8Array(result.audio)).toEqual(bytes);
  });

  it("treats an OK response with no audio bytes as a provider failure", async () => {
    const { transport, calls } = scriptedTts([
      { body: new Uint8Array(0) },
      { body: new Uint8Array(0) },
    ]);
    setTtsTransport(transport);

    await expect(speakText("hello")).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(calls).toHaveLength(2);
  });
});

describe("speakText failure taxonomy and hygiene", () => {
  it("fails with model_unavailable before any call when no key is configured", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const { transport, calls } = scriptedTts([]);
    setTtsTransport(transport);

    await expect(speakText("hello")).rejects.toMatchObject({
      name: "AppError",
      code: "model_unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports configuration through isTtsConfigured without touching stale key names", () => {
    delete process.env.ELEVENLABS_API_KEY;
    // The stale names from the replaced Gemini path (and the Meta key) must
    // never stand in for the ElevenLabs key.
    process.env.META_API_KEY = "decoy-value";
    process.env.GEMINI_API_KEY = "stale-decoy-value";
    expect(isTtsConfigured()).toBe(false);
    process.env.ELEVENLABS_API_KEY = SENTINEL_KEY;
    expect(isTtsConfigured()).toBe(true);
  });

  it("maps exhausted 429s to rate_limited and other failures to model_unavailable", async () => {
    const throttled = scriptedTts([{ status: 429 }, { status: 429 }]);
    setTtsTransport(throttled.transport);
    await expect(speakText("hello")).rejects.toMatchObject({
      code: "rate_limited",
    });

    const unauthorized = scriptedTts([{ status: 401 }, { status: 401 }]);
    setTtsTransport(unauthorized.transport);
    await expect(speakText("hello")).rejects.toMatchObject({
      code: "model_unavailable",
    });

    const down = scriptedTts([{ status: 500 }, { status: 500 }]);
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
    const { transport } = scriptedTts([{}]);
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
