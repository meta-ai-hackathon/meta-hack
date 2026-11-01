import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../../lib/db";
import { runMigrations } from "../../../../../lib/migrate";
import { setLogSink } from "../../../../../lib/telemetry";
import { POST } from "./route";

// POST /api/intake/tax-return/confirm route tests (milestone income-capture
// part 2; VAL-INC-007/011/013). The confirm call is the ONLY writer of
// tax-return-derived answers: a confirmed proposal saves with provenance
// tax_return, a person-corrected value with provenance user; re-confirming
// updates the same rows (update-not-duplicate); non-income and pii
// questions are refused; and the response echoes no values beyond the
// fresh client state the person just confirmed.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_tax_return_confirm";

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
  return new Request("http://localhost:3100/api/intake/tax-return/confirm", {
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

describe("POST /api/intake/tax-return/confirm", () => {
  it("saves a confirmed value with provenance tax_return and status known", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "confirm", value: 52500 },
      ]),
    );

    expect(response.status).toBe(200);
    const rows = await answerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      question_id: "job_income_amount",
      value: 52500,
      status: "known",
      provenance: "tax_return",
    });
  });

  it("saves a corrected value with provenance user", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "correct", value: 48000 },
      ]),
    );

    expect(response.status).toBe(200);
    const rows = await answerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      question_id: "job_income_amount",
      value: 48000,
      status: "known",
      provenance: "user",
    });
  });

  it("saves a mixed batch with per-entry provenance", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "income_sources", action: "confirm", value: ["job"] },
        { questionId: "job_income_amount", action: "correct", value: 500 },
        {
          questionId: "job_income_frequency",
          action: "confirm",
          value: "varies",
        },
      ]),
    );

    expect(response.status).toBe(200);
    const rows = await answerRows(sessionId);
    const byQuestion = new Map(
      rows.map((row) => [row.question_id, row]),
    );
    expect(byQuestion.get("income_sources")).toMatchObject({
      value: ["job"],
      status: "known",
      provenance: "tax_return",
    });
    expect(byQuestion.get("job_income_amount")).toMatchObject({
      value: 500,
      status: "known",
      provenance: "user",
    });
    expect(byQuestion.get("job_income_frequency")).toMatchObject({
      value: "varies",
      status: "known",
      provenance: "tax_return",
    });
  });

  it("re-confirming updates the same rows (update-not-duplicate)", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "confirm", value: 52500 },
      ]),
    );
    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "correct", value: 48000 },
      ]),
    );

    expect(response.status).toBe(200);
    const rows = await answerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      question_id: "job_income_amount",
      value: 48000,
      provenance: "user",
    });
  });

  it("rejects a non-income question id and saves nothing", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "confirm", value: 52500 },
        { questionId: "main_goal", action: "confirm", value: "food" },
      ]),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
    // The whole batch is validated before anything saves: zero rows.
    expect(await answerRows(sessionId)).toHaveLength(0);
  });

  it("rejects a pii:true question id — the vault boundary still bites", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const response = await POST(
      confirmRequest(cookie, [
        {
          questionId: "disability_status",
          action: "confirm",
          value: true,
        },
      ]),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
    expect(await answerRows(sessionId)).toHaveLength(0);
  });

  it("rejects an invalid action and an invalid value, saving nothing", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];

    const badAction = await POST(
      confirmRequest(cookie, [
        {
          questionId: "job_income_amount",
          // A deliberately invalid action: the type allows only confirm |
          // correct, so the invalid spelling arrives cast.
          action: "approve" as "confirm",
          value: 1,
        },
      ]),
    );
    expect(badAction.status).toBe(400);

    const badValue = await POST(
      confirmRequest(cookie, [
        {
          questionId: "job_income_frequency",
          action: "confirm",
          value: "martian",
        },
      ]),
    );
    expect(badValue.status).toBe(400);

    expect(await answerRows(sessionId)).toHaveLength(0);
  });

  it("returns the fresh state, echoing no values in the saved list", async () => {
    const cookie = await createSessionAndGetCookie();

    const response = await POST(
      confirmRequest(cookie, [
        { questionId: "job_income_amount", action: "confirm", value: 52500 },
      ]),
    );

    const body = await response.json();
    // The saved list carries ids and provenance, never values.
    expect(body.saved).toEqual([
      { questionId: "job_income_amount", provenance: "tax_return" },
    ]);
    // The state carries the CONFIRMED answer — the allowance in
    // VAL-INC-013 ("beyond the person's confirmed income answers").
    expect(JSON.stringify(body.state)).toContain("52500");
  });

  it("an unconfirmed upload leaves the state payload with no tax values", async () => {
    const cookie = await createSessionAndGetCookie();

    const response = await POST(confirmRequest(cookie, []));

    // An empty confirmations list is a client bug, not a person action.
    expect(response.status).toBe(400);
  });

  it("creates a session when none exists (answer-route parity)", async () => {
    const response = await POST(
      confirmRequest(undefined, [
        { questionId: "job_income_amount", action: "confirm", value: 52500 },
      ]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("bn_session=");
  });
});
