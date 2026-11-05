import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../../lib/db";
import { runMigrations } from "../../../../../lib/migrate";
import { setLogSink } from "../../../../../lib/telemetry";
import { POST } from "./route";

// POST /api/intake/plaid/confirm route tests (HACK-140). This is the bank
// card's only writer. An untouched proposal (amount or frequency) is
// rejected and never written; only a person-edited value saves
// `known`/`user`.
// The institution name is pii:true metadata kept only in the browser, so it
// never appears here. Re-saving updates the same rows
// (update-not-duplicate); non-income and pii questions are refused; and the
// response echoes no values in the saved list itself.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_plaid_confirm";

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
  process.env.NEXT_PUBLIC_PLAID_DEMO_ENABLED = "true";
  process.env.NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT = "synthetic";
  await runMigrations(testDb);
  setLogSink(() => undefined);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([admin.end({ timeout: 1 }), testDb.end({ timeout: 1 })]);
  await closeDb();
});

afterEach(() => {
  setLogSink(() => undefined);
});

interface ConfirmEntry {
  questionId: string;
  action: "confirm" | "correct";
  value: unknown;
}

function confirmRequest(
  cookie?: string,
  confirmations?: ConfirmEntry[],
): Request {
  return new Request("http://localhost:3100/api/intake/plaid/confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ confirmations: confirmations ?? [] }),
  });
}

async function createSessionAndGetCookie(): Promise<string> {
  const [person] =
    await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`;
  const [session] =
    await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
  return `bn_session=${session.id}`;
}

interface AnswerRow {
  question_id: string;
  value: unknown;
  status: string;
  provenance: string;
}

async function answerRows(sessionId: string): Promise<AnswerRow[]> {
  return testDb`
    SELECT question_id, value, status, provenance
    FROM answer
    WHERE session_id = ${sessionId}
    ORDER BY question_id
  `;
}

describe("POST /api/intake/plaid/confirm", () => {
  it("rejects an untouched bank amount", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "confirm", value: 2100 },
      ]),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
    expect(await answerRows(sessionId)).toHaveLength(0);
  });

  it("rejects an untouched frequency", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        {
          questionId: "job_income_frequency",
          action: "confirm",
          value: "biweekly",
        },
      ]),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
    expect(await answerRows(sessionId)).toHaveLength(0);
  });

  it("saves a corrected value with provenance user", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "correct", value: 1800 },
      ]),
    );

    expect(response.status).toBe(200);
    const rows = await answerRows(sessionId);
    expect(rows[0]).toMatchObject({
      question_id: "job_income_amount",
      value: 1800,
      provenance: "user",
    });
  });

  it("saves a corrected entry", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        {
          questionId: "job_income_frequency",
          action: "correct",
          value: "weekly",
        },
      ]),
    );

    expect(response.status).toBe(200);
    const rows = await answerRows(sessionId);
    const byQuestion = new Map(rows.map((row) => [row.question_id, row]));
    expect(byQuestion.has("job_income_amount")).toBe(false);
    expect(byQuestion.get("job_income_frequency")).toMatchObject({
      value: "weekly",
      status: "known",
      provenance: "user",
    });
  });

  it("rejects a confirm for an id the bank card does not propose, saving nothing", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "income_sources", action: "confirm", value: ["job"] },
      ]),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
    expect(await answerRows(sessionId)).toHaveLength(0);
  });

  it("rejects a pii:true question id, saving nothing", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "disability_status", action: "confirm", value: true },
      ]),
    );

    expect(response.status).toBe(400);
    expect(await answerRows(sessionId)).toHaveLength(0);
  });

  it("re-saving updates the same row (update-not-duplicate)", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "correct", value: 2100 },
      ]),
    );
    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "correct", value: 1800 },
      ]),
    );

    expect(response.status).toBe(200);
    const rows = await answerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      value: 1800,
      provenance: "user",
    });
  });

  it("returns only person-edited ids and provenances in the saved list", async () => {
    const cookie = await createSessionAndGetCookie();

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "correct", value: 2100 },
      ]),
    );

    const body = await response.json();
    expect(body.saved).toEqual([
      {
        questionId: "job_income_amount",
        status: "known",
        provenance: "user",
      },
    ]);
    expect(JSON.stringify(body.state)).toContain("2100");
  });

  it("rejects a confirmed value and saves nothing", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "confirm", value: 2100 },
      ]),
    );

    expect(response.status).toBe(400);
    expect(await answerRows(sessionId)).toHaveLength(0);
  });

  it("answers 404 and saves nothing while the demo switch is off", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    delete process.env.NEXT_PUBLIC_PLAID_DEMO_ENABLED;
    try {
      const response = await POST(
        confirmRequest(cookie, [
          { questionId: "job_income_amount", action: "correct", value: 1800 },
        ]),
      );
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("not_found");
      expect(await answerRows(sessionId)).toHaveLength(0);
    } finally {
      process.env.NEXT_PUBLIC_PLAID_DEMO_ENABLED = "true";
    }
  });
});
