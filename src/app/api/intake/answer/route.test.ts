import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../lib/db";
import { runMigrations } from "../../../../lib/migrate";
import { SESSION_COOKIE } from "../../../../lib/intake/store";
import { POST } from "./route";

// /api/intake/answer route tests (BN-09 / BN-13): the answer POST is the
// surface that creates a visitor's session, so its validation order is a
// contract of its own — a REJECTED answer must never leave an orphan
// person/session row behind (the session is created only for a request that
// gets far enough to need one), and inherited Object keys like "constructor"
// are rejected as question ids, never dereferenced (500-proof).

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_answer_route";

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
  // The route resolves its connection lazily through getDb(); point the
  // environment at the scratch database before any route call.
  process.env.DATABASE_URL = testUrl;
  await runMigrations(testDb);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([
    admin.end({ timeout: 1 }),
    testDb.end({ timeout: 1 }),
  ]);
  await closeDb();
});

function answerRequest(body: unknown, cookie?: string): Request {
  return new Request("http://localhost:3100/api/intake/answer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function countsOf(table: "person" | "session"): Promise<number> {
  const rows = await testDb`SELECT count(*) AS n FROM ${testDb(table)}`;
  return Number(rows[0].n);
}

describe("POST /api/intake/answer", () => {
  it("creates the session on the first valid answer and sets the cookie", async () => {
    const sessionsBefore = await countsOf("session");
    const response = await POST(
      answerRequest({ questionId: "application_role", status: "known", value: "self" }),
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(await countsOf("session")).toBe(sessionsBefore + 1);
    const state = (await response.json()) as {
      answers: Record<string, { status: string }>;
    };
    expect(state.answers.application_role).toEqual({
      status: "known",
      value: "self",
    });
  });

  it("creates no session when the first answer is invalid", async () => {
    const peopleBefore = await countsOf("person");
    const sessionsBefore = await countsOf("session");
    for (const body of [
      { questionId: "not_a_question", status: "known", value: "x" },
      { questionId: "application_role", status: "maybe", value: "self" },
      { questionId: "application_role", status: "known", value: "" },
      { questionId: "application_role", status: "known", value: "martian" },
      { questionId: "constructor", status: "known", value: "self" },
      { questionId: "toString", status: "unknown", value: null },
      { questionId: "__proto__", status: "known", value: "self" },
    ]) {
      const response = await POST(answerRequest(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      const payload = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code, JSON.stringify(body)).toBe("validation_error");
    }
    expect(await countsOf("person")).toBe(peopleBefore);
    expect(await countsOf("session")).toBe(sessionsBefore);
  });

  it("creates no session when the body is not usable JSON", async () => {
    const peopleBefore = await countsOf("person");
    const response = await POST(
      new Request("http://localhost:3100/api/intake/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json at all",
      }),
    );
    expect(response.status).toBe(400);
    expect(await countsOf("person")).toBe(peopleBefore);
  });

  it("answers into an existing session without creating rows", async () => {
    const first = await POST(
      answerRequest({ questionId: "application_role", status: "known", value: "self" }),
    );
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();
    expect(cookie).toContain(SESSION_COOKIE);

    const sessionsBefore = await countsOf("session");
    const response = await POST(
      answerRequest({ questionId: "main_goal", status: "unknown", value: null }, cookie),
    );
    expect(response.status).toBe(200);
    expect(await countsOf("session")).toBe(sessionsBefore);
    const state = (await response.json()) as {
      answers: Record<string, { status: string; value: unknown }>;
    };
    expect(state.answers.application_role).toEqual({
      status: "known",
      value: "self",
    });
    expect(state.answers.main_goal).toEqual({ status: "unknown", value: null });
  });
});
