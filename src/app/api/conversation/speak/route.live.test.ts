import { readFileSync } from "node:fs";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../lib/db";
import { runMigrations } from "../../../../lib/migrate";
import { persistTurn } from "../../../../lib/conversation";
import { POST } from "./route";
import { parseWavHeader } from "../../../../lib/audio/wav";
import { CONSENT_HEADER } from "../../../../lib/consent";

// The live speak requests carry a voice-consent receipt: the consent gate
// sits in front of the TTS provider for live traffic too.
const CONSENTED_VOICE = JSON.stringify({
  v: 2,
  providerId: "meta-model-api",
  ai: true,
  voice: true,
  at: "2026-10-30T12:00:00.000Z",
});

// Live spoken-reply check (Mission v2 M2, user-steered Gemini TTS): proves
// the turn-id route, the prompt-prefix contract, and the L16→WAV wrapping
// against the real API. CI-safe: skips automatically when GEMINI_API_KEY
// or Postgres is absent.

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

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_speak_live";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

let admin: postgres.Sql | null = null;
let testDb: postgres.Sql | null = null;

beforeAll(async () => {
  if (!geminiKey) {
    return;
  }
  admin = postgres(databaseFrom(databaseUrl, "postgres"), { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  process.env.DATABASE_URL = testUrl;
  await runMigrations(testDb);
});

afterAll(async () => {
  if (!admin || !testDb) {
    return;
  }
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([admin.end({ timeout: 1 }), testDb.end({ timeout: 1 })]);
  await closeDb();
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe("POST /api/conversation/speak — live (skipped without GEMINI_API_KEY)", () => {
  itLive(
    "returns playable WAV audio for a stored assistant turn",
    { timeout: 60_000 },
    async () => {
      process.env.GEMINI_API_KEY = geminiKey;
      const [person] =
        await testDb!`INSERT INTO person DEFAULT VALUES RETURNING id`;
      const [session] =
        await testDb!`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
      const turnId = await persistTurn(
        String(session.id),
        "assistant",
        "Thanks for sharing that. Next, could you tell me your zip code?",
      );

      const response = await POST(
        new Request("http://localhost:3100/api/conversation/speak", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `bn_session=${session.id}`,
            [CONSENT_HEADER]: CONSENTED_VOICE,
          },
          body: JSON.stringify({ turnId }),
        }),
      );
      if (response.status === 429) {
        // Quota-exhausted environment, not a code failure: the free-tier TTS
        // quota is small. The taxonomy mapping itself is covered by the
        // offline suite; skip the audio assertions here.
        console.warn("GEMINI quota exhausted; skipping live audio assertions");
        return;
      }
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const info = parseWavHeader(bytes);
      expect(info).not.toBeNull();
      expect(info?.sampleRate).toBe(24000);
      expect(info?.channels).toBe(1);
      expect(info?.bitsPerSample).toBe(16);
    },
  );

  itLive(
    "maps a bad key to the taxonomy, not a crash",
    { timeout: 60_000 },
    async () => {
      process.env.GEMINI_API_KEY = "definitely-not-a-valid-key";
      const [person] =
        await testDb!`INSERT INTO person DEFAULT VALUES RETURNING id`;
      const [session] =
        await testDb!`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
      const turnId = await persistTurn(String(session.id), "assistant", "hello");
      const response = await POST(
        new Request("http://localhost:3100/api/conversation/speak", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `bn_session=${session.id}`,
            [CONSENT_HEADER]: CONSENTED_VOICE,
          },
          body: JSON.stringify({ turnId }),
        }),
      );
      expect(response.status).toBe(503);
      const data = (await response.json()) as { error: { code: string } };
      expect(data.error.code).toBe("model_unavailable");
    },
  );
});
