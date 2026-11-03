import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../lib/db";
import { runMigrations } from "../../../lib/migrate";
import { PII_QUESTION_IDS } from "../../../lib/telemetry";
import { QUESTION_BY_ID, QUESTIONS } from "../../../lib/intake/spec";
import { SESSION_COOKIE } from "../../../lib/intake/store";
import { GET as getState } from "./state/route";
import { POST as postAnswer } from "./answer/route";

// Contract tests for the /api/intake/* route handlers (BN-09). The handlers
// are plain functions of Request, called directly here against the real
// Docker Postgres on a dedicated scratch database. Covers: the read-only
// state GET, the session-creating answer POST with its httpOnly cookie,
// spec-driven state shape, answer persistence, the error taxonomy, and the
// client-payload PII boundary across the full pii population
// (VAL-INTAKE-004).

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_intake_routes";

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
  // Route handlers resolve their connection lazily through getDb().
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

const BASE_URL = "http://localhost:3100/api/intake";

function getRequest(cookie?: string): Request {
  return new Request(`${BASE_URL}/state`, {
    headers: cookie ? { cookie } : {},
  });
}

function postRequest(body: unknown, cookie?: string): Request {
  return new Request(`${BASE_URL}/answer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string | null {
  return response.headers.get("set-cookie");
}

async function sessionCount(): Promise<number> {
  const rows = await testDb`SELECT count(*) AS n FROM session`;
  return Number(rows[0].n);
}

/** First answer POST: creates the visitor session and sets the cookie. */
async function freshSessionCookie(answer: unknown = {
  questionId: "application_role",
  status: "known",
  value: "self",
}): Promise<string> {
  const response = await postAnswer(postRequest(answer));
  const cookie = cookieFrom(response);
  expect(cookie).not.toBeNull();
  return cookie as string;
}

describe("GET /api/intake/state", () => {
  it("returns the empty spec-driven state without creating a session", async () => {
    const before = await sessionCount();
    const response = await getState(getRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();

    const state = (await response.json()) as Record<string, unknown>;
    const questions = state.questions as Array<Record<string, unknown>>;
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0]).toMatchObject({
      id: "application_role",
      type: "single_select",
      required: true,
      pii: false,
    });
    expect(questions[0]).toHaveProperty("prompt");
    expect(questions[0]).toHaveProperty("help");
    expect(questions[0]).toHaveProperty("options");
    expect(state.currentIndex).toBe(0);
    expect(state.complete).toBe(false);
    expect(state.progress).toMatchObject({ answered: 0 });
    expect(await sessionCount()).toBe(before);
  });

  it("resumes persisted answers when the session cookie is present", async () => {
    const cookie = await freshSessionCookie();

    const response = await getState(getRequest(cookie));
    expect(response.status).toBe(200);
    expect(cookieFrom(response)).toBeNull(); // read-only: never re-issues a cookie

    const state = (await response.json()) as {
      answers: Record<string, { status: string; value?: unknown }>;
      progress: { answered: number };
    };
    expect(state.answers.application_role).toEqual({ status: "known", value: "self" });
    expect(state.progress.answered).toBe(1);
  });

  it("lists visible questions in spec order with every spec option label", async () => {
    const response = await getState(getRequest());
    const state = (await response.json()) as {
      questions: Array<{ id: string; options?: Array<{ value: string; label: string }> }>;
    };
    const income = state.questions.find((question) => question.id === "income_sources");
    expect(income?.options).toEqual(QUESTION_BY_ID.income_sources?.options);
    const specIds = QUESTIONS.map((question) => question.id);
    const stateIds = state.questions.map((question) => question.id);
    expect(stateIds).toEqual(
      stateIds
        .slice()
        .sort((a, b) => specIds.indexOf(a) - specIds.indexOf(b)),
    );
  });
});

describe("POST /api/intake/answer", () => {
  it("creates the session, sets the httpOnly cookie, and persists the answer", async () => {
    const before = await sessionCount();
    const response = await postAnswer(
      postRequest({
        questionId: "application_role",
        status: "known",
        value: "self",
      }),
    );
    expect(response.status).toBe(200);

    const cookie = cookieFrom(response);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const state = (await response.json()) as {
      answers: Record<string, { status: string; value?: unknown }>;
      progress: { answered: number };
    };
    expect(state.answers.application_role).toEqual({ status: "known", value: "self" });
    expect(state.progress.answered).toBe(1);
    expect(await sessionCount()).toBe(before + 1);

    const sessionId = (cookie as string).split(";")[0].split("=")[1];
    const rows = await testDb`
      SELECT value, status, provenance FROM answer WHERE session_id = ${sessionId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("self");
    expect(rows[0].provenance).toBe("user_supplied");
  });

  it("stores a pii answer via the vault path and keeps it out of the payload", async () => {
    const cookie = await freshSessionCookie();
    const sessionId = cookie.split(";")[0].split("=")[1];

    const response = await postAnswer(
      postRequest(
        { questionId: "county", status: "known", value: "Franklin County" },
        cookie,
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.text();
    expect(json).not.toContain("Franklin County");
    const state = JSON.parse(json) as {
      answers: Record<string, { status: string }>;
    };
    expect(state.answers.county).toEqual({ status: "known" });

    const vaultRows = await testDb`
      SELECT value FROM vault_entry WHERE session_id = ${sessionId} AND field = 'county'
    `;
    expect(vaultRows).toHaveLength(1);
    // Encrypted at rest (VAL-VAULTENC-001): the stored row is an AES-GCM
    // envelope, never the plaintext (round-trip identity is proven in
    // vault.test.ts through the sanctioned read paths).
    const storedValue = String(vaultRows[0].value);
    expect(storedValue).not.toBe("Franklin County");
    expect(storedValue).toMatch(/^enc1\./);
    const answerRows = await testDb`
      SELECT value FROM answer WHERE session_id = ${sessionId} AND question_id = 'county'
    `;
    expect(answerRows).toHaveLength(1);
    expect(answerRows[0].value).toBeNull();
  });

  it("persists an unknown answer with no value", async () => {
    const cookie = await freshSessionCookie();
    const response = await postAnswer(
      postRequest(
        { questionId: "income_sources", status: "unknown", value: null },
        cookie,
      ),
    );
    expect(response.status).toBe(200);
    const state = (await response.json()) as {
      answers: Record<string, { status: string; value?: unknown }>;
    };
    expect(state.answers.income_sources).toEqual({
      status: "unknown",
      value: null,
    });
  });

  it("fails open to a fresh session on a junk cookie", async () => {
    const before = await sessionCount();
    const response = await postAnswer(
      postRequest(
        { questionId: "application_role", status: "known", value: "self" },
        `${SESSION_COOKIE}=not-a-uuid`,
      ),
    );
    expect(response.status).toBe(200);
    expect(cookieFrom(response)).not.toBeNull();
    expect(await sessionCount()).toBe(before + 1);
  });
});

describe("error taxonomy on the intake surface", () => {
  it("maps invalid bodies and unknown questions to validation_error with the safe copy", async () => {
    const cookie = await freshSessionCookie();

    const badJson = new Request(`${BASE_URL}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "not json",
    });
    const badJsonResponse = await postAnswer(badJson);
    expect(badJsonResponse.status).toBe(400);
    const badJsonBody = (await badJsonResponse.json()) as {
      error: { code: string; message: string };
    };
    expect(badJsonBody.error.code).toBe("validation_error");
    expect(typeof badJsonBody.error.message).toBe("string");

    const unknownQuestion = await postAnswer(
      postRequest(
        { questionId: "not_a_question", status: "known", value: "x" },
        cookie,
      ),
    );
    expect(unknownQuestion.status).toBe(400);
    const unknownBody = (await unknownQuestion.json()) as { error: { code: string } };
    expect(unknownBody.error.code).toBe("validation_error");

    const badStatus = await postAnswer(
      postRequest(
        { questionId: "application_role", status: "eligible", value: "self" },
        cookie,
      ),
    );
    expect(badStatus.status).toBe(400);
    const badStatusBody = (await badStatus.json()) as { error: { code: string } };
    expect(badStatusBody.error.code).toBe("validation_error");
  });
});

describe("full pii population never reaches the client payload (VAL-INTAKE-004)", () => {
  it("answering every pii question leaks no value through any payload", async () => {
    // First POST creates the session and sets the cookie.
    const cookie = await freshSessionCookie({
      questionId: "main_goal",
      status: "known",
      value: "other",
    });

    const textSentinels: Record<string, string> = {
      goal_detail: "SENTINEL-GOAL-TEXT",
      county: "SENTINEL-COUNTY",
      id_issue_detail: "SENTINEL-ID-ISSUE",
      date_of_birth: "1975-04-12",
      phone_contact: "555-010-0000",
      email_contact: "sentinel@example.com",
    };

    let clean = true;
    for (const questionId of PII_QUESTION_IDS) {
      const question = QUESTION_BY_ID[questionId];
      const value = textSentinels[questionId] ?? sentinelValueFor(question);
      const response = await postAnswer(
        postRequest({ questionId, status: "known", value }, cookie),
      );
      expect(response.status, questionId).toBe(200);
      const text = await response.text();
      if (
        textSentinels[questionId] !== undefined &&
        text.includes(textSentinels[questionId])
      ) {
        clean = false;
      }
      // The exact answer shape for a pii question: status alone, no value
      // key — UNLESS an earlier answer in this loop legitimately skipped
      // the question (the work-requirements two-section design: a "yes"
      // on the exemption screen hides the work-activity questions). A
      // skipped question's stored answer is omitted from the served state
      // entirely — pii-safe in the strictest sense (no status, no value).
      const state = JSON.parse(text) as {
        questions: readonly { id: string }[];
        answers: Record<string, Record<string, unknown>>;
      };
      const served = state.questions.some((entry) => entry.id === questionId);
      const expected = served
        ? { status: "known" }
        : undefined;
      if (
        JSON.stringify(state.answers[questionId]) !== JSON.stringify(expected)
      ) {
        clean = false;
      }
    }
    expect(clean).toBe(true);

    const freshState = await getState(getRequest(cookie));
    const freshJson = await freshState.text();
    for (const value of Object.values(textSentinels)) {
      expect(freshJson).not.toContain(value);
    }
  }, 30000);
});

function sentinelValueFor(
  question:
    | { type?: string; options?: readonly { value: string }[] }
    | undefined,
): unknown {
  switch (question?.type) {
    case "multi_select":
      return [question.options?.[0]?.value ?? "x"];
    case "single_select":
      return question.options?.[0]?.value ?? "x";
    case "boolean":
      return true;
    case "number":
      return 1;
    default:
      return "SENTINEL-TEXT";
  }
}
