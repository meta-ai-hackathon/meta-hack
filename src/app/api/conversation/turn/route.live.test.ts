import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../lib/db";
import { runMigrations } from "../../../../lib/migrate";

// Live voice end-to-end (VAL-VOICE-001/002): synthetic spoken WAV fixtures
// (real macOS speech, `say` + `afconvert` per the mission AGENTS.md) driven
// through POST /api/conversation/turn with the REAL Meta STT and chat
// models — asserting the transcript and persistence PARITY with the
// equivalent typed input. CI-safe: everything skips without MODEL_API_KEY.

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

const modelKey = loadEnvKey("MODEL_API_KEY");
const itLive = it.skipIf(!modelKey);

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_voice_live";

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
  if (!modelKey) {
    return;
  }
  admin = postgres(databaseFrom(databaseUrl, "postgres"), { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  process.env.DATABASE_URL = testUrl;
  process.env.MODEL_API_KEY = modelKey;
});

afterAll(async () => {
  if (!admin || !testDb) {
    return;
  }
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([admin.end({ timeout: 1 }), testDb.end({ timeout: 1 })]);
  await closeDb();
});

const { POST } = await import("./route");

// Live requests carry an explicit consent receipt: the gate sits in front
// of the real Meta chat + STT calls (Mission v2.1 M5, HACK-81).
const CONSENTED_VOICE = JSON.stringify({
  v: 1,
  ai: true,
  voice: true,
  at: "2026-10-30T12:00:00.000Z",
});
const CONSENTED_AI = JSON.stringify({
  v: 1,
  ai: true,
  voice: false,
  at: "2026-10-30T12:00:00.000Z",
});

function voiceRequest(wav: Uint8Array, cookie?: string): Request {
  const form = new FormData();
  form.append(
    "audio",
    new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
    "turn.wav",
  );
  return new Request("http://localhost:3100/api/conversation/turn", {
    method: "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      "x-bn-consent": CONSENTED_VOICE,
    },
    body: form,
  });
}

function textRequest(text: string, cookie?: string): Request {
  return new Request("http://localhost:3100/api/conversation/turn", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "x-bn-consent": CONSENTED_AI,
    },
    body: JSON.stringify({ text }),
  });
}

async function applicationRoleRows(): Promise<
  { value: unknown; status: string; provenance: string }[]
> {
  const rows = await testDb!
    `SELECT value, status, provenance FROM answer WHERE question_id = 'application_role' ORDER BY session_id ASC`;
  return rows.map((row) => ({
    value: row.value,
    status: String(row.status),
    provenance: String(row.provenance),
  }));
}

describe("POST /api/conversation/turn — live voice (skipped without MODEL_API_KEY)", () => {
  itLive(
    "transcribes the spoken fixture and persists the same answer as typing it",
    { timeout: 120_000 },
    async () => {
      await runMigrations(testDb!);
      const wav = new Uint8Array(
        readFileSync("specs/fixtures/voice/its-for-myself-16k.wav"),
      );

      // The spoken turn.
      const spoken = await POST(voiceRequest(wav));
      expect(spoken.status).toBe(200);
      const spokenData = (await spoken.json()) as {
        assistantReply: string;
        redactedUserTranscript: string;
        state: { answers: Record<string, { status?: string }> };
      };
      // Keyword assertion (VAL-VOICE-001): not exact punctuation.
      expect(spokenData.redactedUserTranscript.toLowerCase()).toContain(
        "myself",
      );

      // The typed equivalent, in its own session.
      const typed = await POST(textRequest("It's for myself."));
      expect(typed.status).toBe(200);

      const rows = await applicationRoleRows();
      expect(rows).toHaveLength(2);
      // Parity: identical value, status, and provenance for voice and typed.
      expect(rows[0]).toEqual(rows[1]);
      expect(rows[0]).toEqual({
        value: "self",
        status: "known",
        provenance: "user_supplied",
      });
    },
  );

  itLive(
    "accepts the browser-encoder fixture (VAL-VOICE-002 server leg)",
    { timeout: 120_000 },
    async () => {
      await runMigrations(testDb!);
      const wav = new Uint8Array(
        readFileSync("specs/fixtures/voice/its-for-myself-browser-encoded.wav"),
      );
      const response = await POST(voiceRequest(wav));
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        redactedUserTranscript: string;
      };
      expect(data.redactedUserTranscript.length).toBeGreaterThan(0);
    },
  );
});
