import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../lib/db";
import { runMigrations } from "../../../lib/migrate";
import { isVaultEnvelope } from "../../../lib/vault-crypto";
import {
  DEFAULT_PROGRAM_IDS,
  requiredForPrograms,
  remainingQuickQuestions,
} from "../../../lib/intake/requirements";
import {
  QUESTION_BY_ID,
  QUESTIONS,
  type Question,
} from "../../../lib/intake/spec";
import { SESSION_COOKIE } from "../../../lib/intake/store";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import { assertNoPiiValues } from "../../../lib/intake/serialize";
import { GET as getState } from "./state/route";
import { POST as postAnswer } from "./answer/route";
import { GET as getSession } from "../session/route";
import { POST as postPurge } from "../session/purge/route";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Quick-questions persistence, save/resume, and purge over the REAL HTTP
// surface (VAL-QQ-007/008). The stage's saves ride the EXISTING tri-state
// path — POST /api/intake/answer → validateAnswerInput → saveAnswer — so
// these tests drive exactly that route for every question the program-
// requirements engine asks, then inspect the scratch Postgres rows the way
// the contract's docker-exec psql evidence would:
//   - pii:true → AES-GCM ciphertext in vault_entry, answer.value NULL,
//     and no plaintext in any response body;
//   - pii:false → the value in the answer table, status known, provenance
//     user_supplied;
//   - no new intake endpoint, table, or storage semantics anywhere.
// Resume and purge reuse the same machinery a browser reload or the purge
// control would call — the state lives in Postgres, never in memory.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_qq_route";

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
  await Promise.all([
    admin.end({ timeout: 1 }),
    testDb.end({ timeout: 1 }),
  ]);
  await closeDb();
});

const BASE_URL = "http://localhost:3100/api/intake";

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

function stateRequest(cookie?: string): Request {
  return new Request(`${BASE_URL}/state`, {
    headers: cookie ? { cookie } : {},
  });
}

function sessionRequest(cookie?: string): Request {
  return new Request("http://localhost:3100/api/session", {
    headers: cookie ? { cookie } : {},
  });
}

function purgeRequest(cookie?: string, body?: Record<string, unknown>): Request {
  return new Request("http://localhost:3100/api/session/purge", {
    method: "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** A spec-valid known value for each question type (test fixture only). */
function specValueFor(question: Question): string | number | boolean | string[] {
  switch (question.type) {
    case "text":
    case "address":
      return `A test answer for ${question.id}`;
    case "number":
      return 3;
    case "boolean":
      return false;
    case "date":
      return "1990-05-14";
    case "single_select":
      return question.options![0]!.value;
    case "multi_select":
      return [question.options![0]!.value];
  }
}

/** The quick-question universe the engine asks for the default programs. */
const REQUIRED_IDS = requiredForPrograms(DEFAULT_PROGRAM_IDS);

async function answerRow(
  sessionId: string,
  questionId: string,
): Promise<{ value: unknown; status: string; provenance: string } | null> {
  const rows = await testDb`
    SELECT value, status, provenance FROM answer
    WHERE session_id = ${sessionId} AND question_id = ${questionId}
  `;
  const row = rows[0];
  return row
    ? {
        value: row.value,
        status: String(row.status),
        provenance: String(row.provenance),
      }
    : null;
}

async function vaultRow(
  sessionId: string,
  field: string,
): Promise<string | null> {
  const rows = await testDb`
    SELECT value FROM vault_entry
    WHERE session_id = ${sessionId} AND field = ${field}
  `;
  return rows[0] ? String(rows[0].value) : null;
}

describe("quick-question persistence through the existing tri-state path (VAL-QQ-007)", () => {
  it("keeps the HTTP surface to the existing intake endpoints — no new storage route", () => {
    // The stage saves through POST /api/intake/answer exactly like the
    // wizard; no QQ-specific endpoint, table, or route exists.
    const intakeRoutes = readdirSync(
      fileURLToPath(new URL(".", import.meta.url)),
    )
      .filter((entry) => !entry.includes("."))
      .sort();
    expect(intakeRoutes).toEqual(["answer", "state"]);
  });

  it("round-trips the full required universe: pii → vault + NULL, plain → answer row, known + user_supplied", async () => {
    // One session; every answer through the route the stage uses.
    const first = await postAnswer(
      postRequest({
        questionId: REQUIRED_IDS[0],
        status: "known",
        value: specValueFor(QUESTION_BY_ID[REQUIRED_IDS[0]!]),
      }),
    );
    expect(first.status).toBe(200);
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();
    expect(cookie).toContain(`${SESSION_COOKIE}=`);

    for (const id of REQUIRED_IDS.slice(1)) {
      const question = QUESTION_BY_ID[id]!;
      const value = specValueFor(question);
      const response = await postAnswer(
        postRequest({ questionId: id, status: "known", value }, cookie),
      );
      expect(response.status, id).toBe(200);
      // No plaintext PII value may appear in ANY response body — the
      // route's assertNoPiiValues runs on the fresh client state before
      // it is returned. The full-text check applies to free-form values
      // (text/date): select and boolean values are spec vocabulary that
      // legitimately appears in option lists and JSON literals, so their
      // boundary rests on the structural status-only assertion below.
      const body = await response.text();
      if (question.pii && (question.type === "text" || question.type === "date")) {
        expect(body, `response for ${id} leaks the pii value`).not.toContain(
          String(value),
        );
      }
    }

    // The DB rows: exactly the tri-state semantics per question.
    const sessionId = cookie.split("=")[1] ?? "";
    for (const id of REQUIRED_IDS) {
      const question = QUESTION_BY_ID[id]!;
      const row = await answerRow(sessionId, id);
      expect(row, `${id}: answer row exists`).not.toBeNull();
      expect(row!.status, id).toBe("known");
      expect(row!.provenance, id).toBe("user_supplied");
      const stored = await vaultRow(sessionId, id);
      if (question.pii) {
        // The value lives ONLY in the vault, encrypted; the answer row
        // keeps value NULL.
        expect(row!.value, `${id}: pii answer value is NULL`).toBeNull();
        expect(stored, `${id}: vault row exists`).not.toBeNull();
        expect(isVaultEnvelope(stored!), `${id}: AES-GCM envelope`).toBe(true);
        expect(
          stored!.includes(specValueFor(question) as string),
          `${id}: no plaintext in the vault row`,
        ).toBe(false);
      } else {
        expect(row!.value, `${id}: plain value in the answer table`).toEqual(
          specValueFor(question),
        );
        expect(stored, `${id}: no vault row for non-pii`).toBeNull();
      }
    }
  });

  it("serves the resumed state with status-only pii answers and the engine's counts (assertNoPiiValues holds)", async () => {
    // Reuse the session the previous test filled: a fresh GET (the reload
    // path — no in-memory state anywhere) returns the identical view.
    const sessionIdRows = await testDb`SELECT id FROM session LIMIT 1`;
    const sessionId = String(sessionIdRows[0]!.id);
    const cookie = `${SESSION_COOKIE}=${sessionId}`;

    const response = await getState(stateRequest(cookie));
    expect(response.status).toBe(200);
    const state = (await response.json()) as IntakeClientState;

    // The serialization boundary: for every VISIBLE answered question,
    // pii questions surface status ONLY and plain questions their value.
    // (Answers to questions an earlier answer skipped are omitted from
    // the client payload entirely — the rows persist in Postgres, pinned
    // by the row assertions in the previous test.)
    const visibleIds = new Set(state.questions.map((question) => question.id));
    for (const id of REQUIRED_IDS) {
      if (!visibleIds.has(id)) {
        expect(state.answers[id], `${id}: skipped answers stay omitted`).toBeUndefined();
        continue;
      }
      if (!QUESTION_BY_ID[id]!.pii) {
        expect(state.answers[id], id).toEqual({
          status: "known",
          value: specValueFor(QUESTION_BY_ID[id]!),
        });
      } else {
        const answer = state.answers[id] as { status: string; value?: unknown };
        expect(answer?.status, id).toBe("known");
        expect("value" in answer, `${id}: no value key on a pii answer`).toBe(
          false,
        );
      }
    }
    // Defense in depth, proven on this exact payload: the boundary
    // function passes the served state and bites on a poisoned one.
    expect(() => assertNoPiiValues(state)).not.toThrow();
    const poisoned = {
      ...state,
      answers: {
        ...state.answers,
        date_of_birth: { status: "known", value: "1990-05-14" },
      },
    } as IntakeClientState;
    expect(() => assertNoPiiValues(poisoned)).toThrow();

    // The counter the stage renders stays the engine's honest math.
    expect(state.quickQuestions.remainingCount).toBe(0);
    expect(state.quickQuestions.remainingIds).toEqual([]);
    expect(state.quickQuestions.complete).toBe(true);
  });

  it("rejects an invalid quick-question payload with the existing validation error and persists nothing", async () => {
    const sessionsBefore = await testDb`SELECT count(*) AS n FROM session`;
    // Unknown question id.
    const unknown = await postAnswer(
      postRequest({ questionId: "not_a_question", status: "known", value: "x" }),
    );
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );
    // A multi_select value that is not an option array.
    const badShape = await postAnswer(
      postRequest({
        questionId: "income_sources",
        status: "known",
        value: "not an array",
      }),
    );
    expect(badShape.status).toBe(400);
    // An invalid status literal.
    const badStatus = await postAnswer(
      postRequest({ questionId: "main_goal", status: "certain", value: "food" }),
    );
    expect(badStatus.status).toBe(400);
    // A rejected FIRST answer must never leave an orphan session behind.
    const sessionsAfter = await testDb`SELECT count(*) AS n FROM session`;
    expect(Number(sessionsAfter[0]!.n)).toBe(Number(sessionsBefore[0]!.n));
  });
});

describe("quick-question save/resume and purge mid-stage (VAL-QQ-008)", () => {
  /** Answer part of the stage through the route: a multi-select group,
   * a plain single-select, and one pii question (its value vaults). */
  async function seedPartStage(): Promise<{ cookie: string; sessionId: string }> {
    const first = await postAnswer(
      postRequest({
        questionId: "application_role",
        status: "known",
        value: "self",
      }),
    );
    expect(first.status).toBe(200);
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();
    for (const body of [
      { questionId: "income_sources", status: "known", value: ["job", "benefits"] },
      { questionId: "housing_status", status: "known", value: "staying_with_others" },
    ]) {
      const response = await postAnswer(postRequest(body, cookie));
      expect(response.status, String(body.questionId)).toBe(200);
    }
    const sessionIdRows =
      await testDb`SELECT id FROM session ORDER BY created_at DESC LIMIT 1`;
    return { cookie, sessionId: String(sessionIdRows[0]!.id) };
  }

  it("resuming restores the answers, the remaining set, and consistent counts from Postgres", async () => {
    const { cookie, sessionId } = await seedPartStage();

    // Resume on BOTH read surfaces a reload uses: the intake state route
    // and the conversation-history/session state (same builder).
    const stateResponse = await getState(stateRequest(cookie));
    expect(stateResponse.status).toBe(200);
    const state = (await stateResponse.json()) as IntakeClientState;
    const sessionResponse = await getSession(sessionRequest(cookie));
    expect(sessionResponse.status).toBe(200);
    const sessionState =
      ((await sessionResponse.json()) as { state: IntakeClientState }).state;

    // The saved group values round-trip identically; the pii answer
    // surfaces as its status alone.
    expect(state.answers.application_role).toEqual({
      status: "known",
      value: "self",
    });
    expect(state.answers.income_sources).toEqual({
      status: "known",
      value: ["job", "benefits"],
    });
    expect(state.answers.housing_status).toEqual({ status: "known" });

    // The remaining set excludes everything answered; the counts are the
    // engine's own math over the stored answers (never hardcoded).
    const answeredRequired = REQUIRED_IDS.filter((id) =>
      ["application_role", "income_sources", "housing_status"].includes(id),
    );
    const storedMap: Record<string, { status: "known"; value?: unknown }> = {
      application_role: { status: "known", value: "self" },
      income_sources: { status: "known", value: ["job", "benefits"] },
      housing_status: { status: "known", value: "staying_with_others" },
    };
    const engine = remainingQuickQuestions(storedMap);
    expect(state.quickQuestions.remainingIds).toEqual(engine.remainingIds);
    expect(state.quickQuestions.remainingCount).toBe(engine.remainingCount);
    for (const id of answeredRequired) {
      expect(state.quickQuestions.remainingIds, id).not.toContain(id);
    }
    expect(state.quickQuestions.remainingCount).toBeLessThan(
      state.quickQuestions.requiredCount,
    );
    expect(state.quickQuestions.remainingCount).toBe(
      state.quickQuestions.remainingIds.length,
    );
    // Progress over the visible questions stays consistent too.
    expect(state.progress.answered).toBe(
      state.progress.total - state.progress.remaining,
    );
    // Both resume surfaces agree byte-for-byte (one builder, one DB).
    expect(sessionState).toEqual(state);
    void sessionId;
  });

  it("purge refuses without confirmation and, with {confirmed:true}, clears the quick-question answers including vault rows", async () => {
    const { cookie, sessionId } = await seedPartStage();

    const rowsBefore = await testDb`
      SELECT
        (SELECT count(*) FROM answer WHERE session_id = ${sessionId}) AS answer,
        (SELECT count(*) FROM vault_entry WHERE session_id = ${sessionId}) AS vault_entry
    `;
    expect(Number(rowsBefore[0]!.answer)).toBe(3);
    expect(Number(rowsBefore[0]!.vault_entry)).toBe(1); // housing_status

    // Without the confirmation nothing is deleted.
    const refused = await postPurge(purgeRequest(cookie));
    expect(refused.status).toBe(400);
    const rowsAfterRefusal = await testDb`
      SELECT
        (SELECT count(*) FROM answer WHERE session_id = ${sessionId}) AS answer,
        (SELECT count(*) FROM vault_entry WHERE session_id = ${sessionId}) AS vault_entry
    `;
    expect(Number(rowsAfterRefusal[0]!.answer)).toBe(3);
    expect(Number(rowsAfterRefusal[0]!.vault_entry)).toBe(1);

    // The confirmed purge clears every quick-question answer — the plain
    // rows AND the vault row — like everything else.
    const purged = await postPurge(purgeRequest(cookie, { confirmed: true }));
    expect(purged.status).toBe(200);
    const payload = (await purged.json()) as {
      purged: boolean;
      deleted: { answers: number; vaultEntries: number };
    };
    expect(payload.purged).toBe(true);
    expect(payload.deleted.answers).toBe(3);
    expect(payload.deleted.vaultEntries).toBe(1);
    const rowsAfter = await testDb`
      SELECT
        (SELECT count(*) FROM answer WHERE session_id = ${sessionId}) AS answer,
        (SELECT count(*) FROM vault_entry WHERE session_id = ${sessionId}) AS vault_entry
    `;
    expect(Number(rowsAfter[0]!.answer)).toBe(0);
    expect(Number(rowsAfter[0]!.vault_entry)).toBe(0);

    // A reload after the purge shows the honest empty stage: N back to M.
    const stateResponse = await getState(stateRequest(cookie));
    expect(stateResponse.status).toBe(200);
    const state = (await stateResponse.json()) as IntakeClientState;
    expect(state.answers).toEqual({});
    expect(state.quickQuestions.remainingCount).toBe(
      state.quickQuestions.requiredCount,
    );
    expect(state.quickQuestions.remainingIds).toEqual(
      QUESTIONS.filter((question) =>
        state.quickQuestions.requiredIds.includes(question.id),
      ).map((question) => question.id),
    );
  });
});
