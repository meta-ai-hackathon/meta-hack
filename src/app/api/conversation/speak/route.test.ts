import { readFileSync } from "node:fs";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../lib/db";
import { runMigrations } from "../../../../lib/migrate";
import { persistTurn } from "../../../../lib/conversation";
import { resetTtsTransport, setTtsTransport, type TtsTransport } from "../../../../lib/tts";
import { parseWavHeader } from "../../../../lib/audio/wav";
import { setLogSink, type LogLine } from "../../../../lib/telemetry";
import { CONSENT_HEADER } from "../../../../lib/consent";
import { POST } from "./route";

// Spoken-reply route tests (Mission v2 M2): the server proxies Gemini TTS
// so the API key never reaches the browser. Contract (claude-review
// P1-1/P2-1): the request carries a TURN ID — the route speaks only a
// stored, session-owned, REDACTED assistant turn, never client-supplied
// text. Failures map to the taxonomy; the client falls back to browser
// speechSynthesis on any non-200.

const SENTINEL_KEY = "sentinel-gemini-key-abc123";

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_speak";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

let admin: postgres.Sql;
let testDb: postgres.Sql;

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  process.env.DATABASE_URL = testUrl;
  await runMigrations(testDb);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([admin.end({ timeout: 1 }), testDb.end({ timeout: 1 })]);
  await closeDb();
});

afterEach(() => {
  resetTtsTransport();
  setLogSink(() => undefined);
  delete process.env.GEMINI_API_KEY;
});

/** One session with two stored assistant turns; returns [sessionId, turnIds]. */
async function seedTurns(): Promise<{ sessionId: string; turnIds: string[] }> {
  await testDb`TRUNCATE person, session, answer, vault_entry, conversation_turn CASCADE`;
  const [person] = await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`;
  const [session] =
    await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
  const first = await persistTurn(String(session.id), "assistant", "Got it. What kind of help are you looking for right now?");
  await persistTurn(String(session.id), "user", "hello");
  const second = await persistTurn(String(session.id), "assistant", "Thanks. What is your email address?");
  return { sessionId: String(session.id), turnIds: [first, second] };
}

function speakRequest(
  turnId: string | null,
  cookie?: string,
  consent: string | null = CONSENTED_VOICE,
): Request {
  return new Request("http://localhost:3100/api/conversation/speak", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(consent === null ? {} : { [CONSENT_HEADER]: consent }),
    },
    body: JSON.stringify({ turnId }),
  });
}

function cookieFor(sessionId: string): string {
  return `bn_session=${sessionId}`;
}

function scriptedTtsOk(): void {
  setTtsTransport((async () => {
    const pcm = new Int16Array(240);
    const bytes = new Uint8Array(pcm.buffer.slice(0));
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return new Response(
      JSON.stringify({
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
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as TtsTransport);
}

describe("POST /api/conversation/speak — turn-id contract", () => {
  it("speaks a stored assistant turn for the caller's session as WAV", async () => {
    const { sessionId, turnIds } = await seedTurns();
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    scriptedTtsOk();

    const response = await POST(speakRequest(turnIds[0], cookieFor(sessionId)));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(parseWavHeader(bytes)).not.toBeNull();
    // The provider call carried the STORED turn text.
    const calls: { body: string }[] = [];
    setTtsTransport((async (_url, init) => {
      calls.push({ body: String(init.body) });
      return new Response("{}", { status: 200 });
    }) as TtsTransport);
    await POST(speakRequest(turnIds[1], cookieFor(sessionId)));
    expect(calls[0]?.body).toContain("What is your email address");
  });

  it("never speaks another session's turn or a user turn", async () => {
    const { sessionId, turnIds } = await seedTurns();
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    let called = false;
    setTtsTransport((async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as TtsTransport);

    // Unknown turn id.
    const unknown = await POST(
      speakRequest("00000000-0000-4000-8000-000000000000", cookieFor(sessionId)),
    );
    expect(unknown.status).toBe(404);
    // The user turn of the SAME session.
    const rows = await testDb`
      SELECT id FROM conversation_turn WHERE role = 'user' LIMIT 1
    `;
    const userTurn = await POST(
      speakRequest(String(rows[0].id), cookieFor(sessionId)),
    );
    expect(userTurn.status).toBe(404);
    expect(called).toBe(false);
    void turnIds;
  });

  it("requires a session: no cookie is a 404, never a proxy", async () => {
    const { turnIds } = await seedTurns();
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    let called = false;
    setTtsTransport((async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as TtsTransport);

    for (const request of [
      speakRequest(turnIds[0]),
      speakRequest(null),
      speakRequest("not-a-uuid"),
    ]) {
      const response = await POST(request);
      expect(response.status).toBe(404);
    }
    // A malformed body is a validation error, still never a proxy call.
    const malformed = await POST(
      new Request("http://localhost:3100/api/conversation/speak", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CONSENT_HEADER]: CONSENTED_VOICE,
        },
        body: "not json",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(called).toBe(false);
  });

  it("serves a repeated turn id from the cache without a second provider call (claude-review P3)", async () => {
    const { sessionId, turnIds } = await seedTurns();
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    let calls = 0;
    setTtsTransport((async () => {
      calls += 1;
      const pcm = new Int16Array(240);
      const bytes = new Uint8Array(pcm.buffer.slice(0));
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/L16;rate=24000",
                      data: btoa(binary),
                    },
                  },
                ],
                role: "model",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as TtsTransport);

    const first = await POST(speakRequest(turnIds[1], cookieFor(sessionId)));
    const second = await POST(speakRequest(turnIds[1], cookieFor(sessionId)));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toBe(1);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    const secondBytes = Buffer.from(await second.arrayBuffer());
    expect(firstBytes.length).toBeGreaterThan(0);
    expect(secondBytes.equals(firstBytes)).toBe(true);
  });

  it("degrades with model_unavailable when no key is configured", async () => {
    const { sessionId, turnIds } = await seedTurns();
    let called = false;
    setTtsTransport((async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as TtsTransport);

    const response = await POST(
      speakRequest(turnIds[0], cookieFor(sessionId)),
    );
    expect(response.status).toBe(503);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("model_unavailable");
    expect(called).toBe(false);
  });

  it("never logs the spoken text or the key", async () => {
    const { sessionId, turnIds } = await seedTurns();
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    scriptedTtsOk();
    const logs: LogLine[] = [];
    setLogSink((line) => logs.push(JSON.parse(line) as LogLine));

    await POST(speakRequest(turnIds[0], cookieFor(sessionId)));

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("What kind of help are you looking");
    expect(serialized).not.toContain(SENTINEL_KEY);
  });
});

// ---------------------------------------------------------------------------
// Consent gate (Mission v2.1 M5, HACK-81, VAL-CONSENT-003): spoken replies
// via Gemini TTS are a send — they ride behind the voice toggle, and a
// request without the voice consent never reaches the TTS provider. The
// client falls back to browser speechSynthesis (local, no send).
// ---------------------------------------------------------------------------

const CONSENTED_VOICE = JSON.stringify({
  v: 2,
  providerId: "meta-model-api",
  ai: true,
  voice: true,
  at: "2026-10-30T12:00:00.000Z",
});
const CONSENTED_AI_ONLY = JSON.stringify({
  v: 2,
  providerId: "meta-model-api",
  ai: true,
  voice: false,
  at: "2026-10-30T12:00:00.000Z",
});

describe("POST /api/conversation/speak — consent gate (VAL-CONSENT-003)", () => {
  it("refuses a speak request with no receipt before any provider call", async () => {
    const { sessionId, turnIds } = await seedTurns();
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    let called = false;
    setTtsTransport((async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as TtsTransport);

    const response = await POST(
      speakRequest(turnIds[0], cookieFor(sessionId), null),
    );
    expect(response.status).toBe(403);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("consent_required");
    expect(called).toBe(false);
  });

  it("refuses a speak request whose receipt lacks the voice toggle", async () => {
    const { sessionId, turnIds } = await seedTurns();
    process.env.GEMINI_API_KEY = SENTINEL_KEY;
    let called = false;
    setTtsTransport((async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as TtsTransport);

    const response = await POST(
      speakRequest(turnIds[0], cookieFor(sessionId), CONSENTED_AI_ONLY),
    );
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe(
      "consent_required",
    );
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TTS payload hygiene (natural-conversation milestone, VAL-VTTS-003): the
// ONLY text that ever reaches the Gemini TTS transport is the STORED
// assistant reply — a full-population check that no pii:true value and no
// user-turn text appears in any provider payload.
// ---------------------------------------------------------------------------

const SPEC_PATH = new URL(
  "../../../../../specs/question-spec/generic-questions.json",
  import.meta.url,
);
const SPEC_PII_FIELDS: readonly string[] = (
  JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
    questions: { id: string; pii: boolean }[];
  }
).questions
  .filter((question) => question.pii)
  .map((question) => question.id);

describe("POST /api/conversation/speak — TTS payload hygiene (VAL-VTTS-003)", () => {
  it("sends zero pii:true values and zero user-turn text to the provider (full population)", async () => {
    expect(SPEC_PII_FIELDS.length).toBeGreaterThan(0);
    const { sessionId } = await seedTurns();
    process.env.GEMINI_API_KEY = SENTINEL_KEY;

    // A user turn seeded with EVERY pii:true value in the spec, followed by
    // the assistant reply the route is asked to speak.
    const piiUserText = SPEC_PII_FIELDS.map(
      (id) => `My ${id} is pii-sentinel-${id}`,
    ).join(" And ");
    await persistTurn(sessionId, "user", piiUserText);
    const replyId = await persistTurn(
      sessionId,
      "assistant",
      "Thanks. What is your email address?",
    );

    const payloadBodies: string[] = [];
    setTtsTransport((async (_url, init) => {
      payloadBodies.push(String(init.body));
      const pcm = new Int16Array(240);
      const bytes = new Uint8Array(pcm.buffer.slice(0));
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/L16;rate=24000",
                      data: btoa(binary),
                    },
                  },
                ],
                role: "model",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as TtsTransport);

    const response = await POST(speakRequest(replyId, cookieFor(sessionId)));
    expect(response.status).toBe(200);
    expect(payloadBodies).toHaveLength(1);

    // The payload carries the assistant reply text — and nothing else.
    const payload = JSON.parse(payloadBodies[0]) as {
      contents: { parts: { text: string }[] }[];
    };
    expect(payload.contents[0]?.parts[0]?.text).toBe(
      "Thanks. What is your email address?",
    );
    // No user-turn text: none of the pii sentinels, none of the phrasing.
    for (const id of SPEC_PII_FIELDS) {
      expect(payloadBodies[0]).not.toContain(`pii-sentinel-${id}`);
      expect(payloadBodies[0]).not.toContain(`My ${id} is`);
    }
    expect(payloadBodies[0]).not.toContain("And ");
  });
});
