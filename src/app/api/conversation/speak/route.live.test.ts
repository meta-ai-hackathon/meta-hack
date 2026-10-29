import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { parseWavHeader } from "../../../../lib/audio/wav";

// Live spoken-reply check (Mission v2 M2, user-steered Gemini TTS): proves
// the route, the prompt-prefix contract, and the L16→WAV wrapping against
// the real API. CI-safe: skips automatically when GEMINI_API_KEY is absent
// (no .env in CI), so CI stays green.

function loadEnvKey(name: string): string | undefined {
  if (process.env[name]) {
    return process.env[name];
  }
  try {
    const raw = readFileSync(
      new URL("../../../../../.env", import.meta.url),
      "utf8",
    );
    const line = raw
      .split("\n")
      .find((candidate) => candidate.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

const geminiKey = loadEnvKey("GEMINI_API_KEY");
const itLive = it.skipIf(!geminiKey);

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe("POST /api/conversation/speak — live (skipped without GEMINI_API_KEY)", () => {
  itLive("returns playable WAV audio for an assistant reply", { timeout: 30_000 }, async () => {
    process.env.GEMINI_API_KEY = geminiKey;
    const response = await POST(
      new Request("http://localhost:3100/api/conversation/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text:
            "Thanks for sharing that. Next, could you tell me your zip code?",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const info = parseWavHeader(bytes);
    expect(info).not.toBeNull();
    expect(info?.sampleRate).toBe(24000);
    expect(info?.channels).toBe(1);
    expect(info?.bitsPerSample).toBe(16);
  });

  itLive("maps a bad key to the taxonomy, not a crash", { timeout: 30_000 }, async () => {
    process.env.GEMINI_API_KEY = "definitely-not-a-valid-key";
    const response = await POST(
      new Request("http://localhost:3100/api/conversation/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(response.status).toBe(503);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("model_unavailable");
  });
});
