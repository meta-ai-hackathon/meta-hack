import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../lib/db";
import { runMigrations } from "../../../../lib/migrate";
import {
  ensureSession,
  loadAnswers,
  saveAnswer,
  SESSION_COOKIE,
} from "../../../../lib/intake/store";
import { buildClientState } from "../../../../lib/intake/serialize";
import { persistTurn } from "../../../../lib/conversation";
import { GET } from "./route";

// Conversation history route tests (Mission v2 M1): resume support. The
// route is read-only (no session creation, no cookie writes) and restores
// the redacted transcript + answer state purely from Postgres — reload and
// server-restart parity is a property of that persistence.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_conversation_history";

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

function historyRequest(cookie?: string): Request {
  return new Request("http://localhost:3100/api/conversation/history", {
    headers: cookie ? { cookie } : {},
  });
}

interface HistoryResponse {
  turns: {
    id: string;
    role: string;
    transcript: string;
    createdAt: string;
  }[];
  state: ReturnType<typeof buildClientState>;
}

describe("GET /api/conversation/history", () => {
  it("returns an empty transcript and fresh state for a visitor with no session, creating nothing", async () => {
    const sessionsBefore = await countOf("session");
    const response = await GET(historyRequest());
    expect(response.status).toBe(200);
    const data = (await response.json()) as HistoryResponse;
    expect(data.turns).toEqual([]);
    expect(data.state.questions.length).toBeGreaterThan(0);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await countOf("session")).toBe(sessionsBefore);
  });

  it("fails open with an empty transcript for a junk or unknown cookie", async () => {
    const response = await GET(
      historyRequest(`${SESSION_COOKIE}=not-a-uuid`),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as HistoryResponse;
    expect(data.turns).toEqual([]);
  });

  it("restores identical turns and state on repeated reads (reload parity)", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "application_role", "known", "self");
    await saveAnswer(sessionId, "main_goal", "unknown", null);
    await persistTurn(sessionId, "user", "It's for me, and I'm not sure about the goal");
    await persistTurn(
      sessionId,
      "assistant",
      "That's okay — not knowing is fine. Which state do you live in?",
    );

    const cookie = `${SESSION_COOKIE}=${sessionId}`;
    const first = await GET(historyRequest(cookie));
    expect(first.status).toBe(200);
    const firstData = (await first.json()) as HistoryResponse;

    expect(firstData.turns).toHaveLength(2);
    expect(firstData.turns[0]?.role).toBe("user");
    expect(firstData.turns[0]?.transcript).toBe(
      "It's for me, and I'm not sure about the goal",
    );
    expect(firstData.turns[1]?.role).toBe("assistant");
    expect(firstData.turns[1]?.transcript).toContain("not knowing is fine");
    for (const turn of firstData.turns) {
      expect(typeof turn.createdAt).toBe("string");
      expect(Number.isNaN(Date.parse(turn.createdAt))).toBe(false);
    }
    expect(firstData.state.answers.application_role).toEqual({
      status: "known",
      value: "self",
    });
    expect(firstData.state.answers.main_goal).toEqual({
      status: "unknown",
      value: null,
    });

    const expectedState = buildClientState(await loadAnswers(sessionId));
    expect(firstData.state).toEqual(expectedState);

    const second = await GET(historyRequest(cookie));
    const secondData = (await second.json()) as HistoryResponse;
    expect(secondData).toEqual(firstData);
  });

  it("surfaces only redacted transcripts: storage rows and reads agree", async () => {
    const { sessionId } = await ensureSession(null);
    await persistTurn(sessionId, "user", "call me at [redacted personal detail]");
    const rows = await testDb`
      SELECT redacted_transcript FROM conversation_turn WHERE session_id = ${sessionId}
    `;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].redacted_transcript)).toBe(
      "call me at [redacted personal detail]",
    );
    const cookie = `${SESSION_COOKIE}=${sessionId}`;
    const response = await GET(historyRequest(cookie));
    const data = (await response.json()) as HistoryResponse;
    expect(data.turns[0]?.transcript).toBe(
      "call me at [redacted personal detail]",
    );
  });
});

async function countOf(table: "person" | "session"): Promise<number> {
  const rows = await testDb`SELECT count(*) AS n FROM ${testDb(table)}`;
  return Number(rows[0].n);
}
