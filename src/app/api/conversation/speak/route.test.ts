import { afterEach, describe, expect, it } from "vitest";
import { resetTtsTransport, setTtsTransport, type TtsTransport } from "../../../../lib/tts";
import { parseWavHeader } from "../../../../lib/audio/wav";
import { setLogSink, type LogLine } from "../../../../lib/telemetry";
import { POST } from "./route";

// Spoken-reply route tests (Mission v2 M2): the server proxies Gemini TTS
// so the API key never reaches the browser. Failures map to the taxonomy;
// the client falls back to browser speechSynthesis on any non-200.

const SENTINEL_KEY = "sentinel-gemini-key-abc123";

function ttsWavBody(): unknown {
  // One second of silence as L16 PCM at 24 kHz, base64-encoded.
  const pcm = new Int16Array(24000);
  let binary = "";
  const bytes = new Uint8Array(pcm.buffer.slice(0));
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return {
    candidates: [
      {
        content: {
          parts: [
            { inlineData: { mimeType: "audio/L16;rate=24000", data: btoa(binary) } },
          ],
          role: "model",
        },
      },
    ],
  };
}

function speakRequest(body: unknown): Request {
  return new Request("http://localhost:3100/api/conversation/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resetTtsTransport();
  setLogSink(() => undefined);
  delete process.env.GEMINI_API_KEY;
});

describe("POST /api/conversation/speak", () => {
  it("returns WAV audio bytes for a bounded reply text", async () => {
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    setTtsTransport((async () =>
      new Response(JSON.stringify(ttsWavBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as TtsTransport);

    const response = await POST(speakRequest({ text: "Thanks for telling me." }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(parseWavHeader(bytes)).not.toBeNull();
  });

  it("rejects unusable text with validation_error", async () => {
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    let called = false;
    setTtsTransport((async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as TtsTransport);

    for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, "junk"]) {
      const response = await POST(speakRequest(body));
      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: { code: string } };
      expect(data.error.code).toBe("validation_error");
    }
    expect(called).toBe(false);
  });

  it("degrades with model_unavailable when no key is configured", async () => {
    let called = false;
    setTtsTransport((async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as TtsTransport);

    const response = await POST(speakRequest({ text: "hello there" }));
    expect(response.status).toBe(503);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("model_unavailable");
    expect(called).toBe(false);
  });

  it("maps exhausted TTS rate limits to rate_limited", async () => {
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    setTtsTransport((async () =>
      new Response("{}", { status: 429 })) as TtsTransport);

    const response = await POST(speakRequest({ text: "hello there" }));
    expect(response.status).toBe(429);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("rate_limited");
  });

  it("never logs the spoken text or the key", async () => {
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    setTtsTransport((async () =>
      new Response(JSON.stringify(ttsWavBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as TtsTransport);
    const logs: LogLine[] = [];
    setLogSink((line) => logs.push(JSON.parse(line) as LogLine));

    await POST(speakRequest({ text: "a private-ish assistant sentence" }));

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("a private-ish assistant sentence");
    expect(serialized).not.toContain(SENTINEL_KEY);
  });
});
