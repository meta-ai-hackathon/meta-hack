import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import fc from "fast-check";
import { closeDb } from "../db";
import { runMigrations } from "../migrate";
import { AppError } from "../telemetry";
import type { AnswerMap } from "./flow";
import { QUESTION_BY_ID, type Question } from "./spec";
import { PII_QUESTION_IDS_IN_SPEC } from "./spec";
import {
  SESSION_COOKIE,
  ensureSession,
  loadAnswers,
  loadSession,
  loadSessionState,
  readSessionCookie,
  recordCaseworkerAssist,
  saveAnswer,
  sessionCookieHeader,
} from "./store";

// Intake store integration tests (BN-09 / HACK-37). Runs against the real
// Docker Postgres on its own scratch database (independent of the other
// suites' scratch databases), dropped and re-created from scratch every run.
//
// Contracts under test:
// - ensureSession: cookie-less visitors get a fresh person+session; a cookie
//   naming an existing session resumes it; junk cookies fail open to a fresh
//   session (never a 500).
// - saveAnswer: non-pii values go to the answer table; pii values go to the
//   vault path and the answer row's value stays NULL; unknown answers store
//   no value anywhere; re-answering updates rather than duplicates.
// - loadAnswers: the tri-state answer map round-trips.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_intake_store";

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
  // store.ts resolves its connection lazily through getDb(); point the
  // environment at the scratch database before any store call.
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

async function answerRows(sessionId: string) {
  return testDb`
    SELECT question_id, value, status, provenance
    FROM answer
    WHERE session_id = ${sessionId}
    ORDER BY question_id
  `;
}

async function vaultRows(sessionId: string) {
  return testDb`
    SELECT field, value FROM vault_entry WHERE session_id = ${sessionId}
  `;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (caught) {
    return caught;
  }
  throw new Error("expected promise to reject");
}

describe("session cookie helpers", () => {
  it("round-trips the session cookie from a Cookie header", () => {
    const header = sessionCookieHeader("abc-123");
    expect(header).toContain(`${SESSION_COOKIE}=abc-123`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(readSessionCookie(`${SESSION_COOKIE}=abc-123; other=x`)).toBe("abc-123");
    expect(readSessionCookie("other=x")).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });
});

describe("ensureSession", () => {
  it("creates a person and a draft session for a fresh visitor", async () => {
    const { sessionId, fresh } = await ensureSession(null);
    expect(fresh).toBe(true);
    const rows = await testDb`
      SELECT session.status, session.person_id, person.id AS person_id
      FROM session JOIN person ON person.id = session.person_id
      WHERE session.id = ${sessionId}
    `;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].status)).toBe("draft");
  });

  it("resumes an existing session by cookie value", async () => {
    const first = await ensureSession(null);
    const second = await ensureSession(first.sessionId);
    expect(second).toEqual({ sessionId: first.sessionId, fresh: false });
  });

  it("fails open to a fresh session on junk or unknown cookie values", async () => {
    for (const junk of ["not-a-uuid", "'; DROP TABLE session; --", crypto.randomUUID()]) {
      const { sessionId, fresh } = await ensureSession(junk);
      expect(fresh, junk).toBe(true);
      const rows = await testDb`SELECT id FROM session WHERE id = ${sessionId}`;
      expect(rows, junk).toHaveLength(1);
    }
  });

  it("loadSession resolves only existing sessions and never creates one", async () => {
    const before = await testDb`SELECT count(*) AS n FROM session`;
    expect(await loadSession(null)).toBeNull();
    expect(await loadSession("not-a-uuid")).toBeNull();
    expect(await loadSession(crypto.randomUUID())).toBeNull();
    const { sessionId } = await ensureSession(null);
    expect(await loadSession(sessionId)).toBe(sessionId);
    const after = await testDb`SELECT count(*) AS n FROM session`;
    expect(Number(after[0].n)).toBe(Number(before[0].n) + 1);
  });
});

describe("saveAnswer routing (non-pii → answer table, pii → vault)", () => {
  it("stores a non-pii known answer with provenance user_supplied", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "application_role", "known", "self");
    const rows = await answerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].question_id).toBe("application_role");
    expect(rows[0].value).toBe("self");
    expect(rows[0].status).toBe("known");
    expect(rows[0].provenance).toBe("user_supplied");
    expect(await vaultRows(sessionId)).toHaveLength(0);
  });

  it("sends a pii known answer to the vault and keeps the answer value NULL", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "county", "known", "Franklin");
    const rows = await answerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].question_id).toBe("county");
    expect(rows[0].value).toBeNull();
    expect(rows[0].status).toBe("known");
    const vault = await vaultRows(sessionId);
    expect(vault).toHaveLength(1);
    expect(vault[0].field).toBe("county");
    expect(vault[0].value).toBe("Franklin");
  });

  it("stores an unknown answer as status only — no value anywhere", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "housing_status", "unknown", null);
    const rows = await answerRows(sessionId);
    expect(rows[0].status).toBe("unknown");
    expect(rows[0].value).toBeNull();
    expect(await vaultRows(sessionId)).toHaveLength(0);
  });

  it("re-answering updates the same row", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "application_role", "known", "self");
    await saveAnswer(sessionId, "application_role", "unverified", "family_member");
    const rows = await answerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unverified");
    expect(rows[0].value).toBe("family_member");
  });

  it("deletes the vault value when a pii answer is disavowed to unknown", async () => {
    // BN-13 hygiene: answering "I'm not sure" after a known pii answer must
    // not leave the stale value in the vault (retained-data hygiene — the
    // flow engine ignores it and serialization strips it, but the row would
    // linger).
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "housing_status", "known", "shelter");
    expect(await vaultRows(sessionId)).toHaveLength(1);
    await saveAnswer(sessionId, "housing_status", "unknown", null);
    expect(await vaultRows(sessionId)).toHaveLength(0);
    const rows = await answerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unknown");
    expect(rows[0].value).toBeNull();
  });

  it("re-answering known after disavow re-puts the vault value", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "housing_status", "known", "shelter");
    await saveAnswer(sessionId, "housing_status", "unknown", null);
    await saveAnswer(sessionId, "housing_status", "unverified", "car");
    const vault = await vaultRows(sessionId);
    expect(vault).toHaveLength(1);
    expect(vault[0].field).toBe("housing_status");
    expect(vault[0].value).toBe("car");
  });
});

describe("loadAnswers round-trip", () => {
  it("returns the tri-state map with values intact", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "application_role", "known", "self");
    await saveAnswer(sessionId, "household_size", "known", 4);
    await saveAnswer(sessionId, "veteran_status", "known", true);
    await saveAnswer(sessionId, "income_sources", "known", ["job", "benefits"]);
    await saveAnswer(sessionId, "main_goal", "unknown", null);
    await saveAnswer(sessionId, "housing_cost", "unverified", 800);
    await saveAnswer(sessionId, "county", "known", "Franklin");

    const answers = await loadAnswers(sessionId);
    expect(answers.application_role).toEqual({ status: "known", value: "self" });
    expect(answers.household_size).toEqual({ status: "known", value: 4 });
    expect(answers.veteran_status).toEqual({ status: "known", value: true });
    expect(answers.income_sources).toEqual({
      status: "known",
      value: ["job", "benefits"],
    });
    expect(answers.main_goal).toEqual({ status: "unknown", value: null });
    expect(answers.housing_cost).toEqual({ status: "unverified", value: 800 });
    // pii value never sat in the answer table, but loadAnswers merges it
    // back from the vault so the server-side flow engine can evaluate skip
    // conditions on pii answers (never serialized to the client).
    expect(answers.county).toEqual({ status: "known", value: "Franklin" });
  });

  it("keeps unknown pii answers value-less after the vault merge", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "housing_status", "unknown", null);
    const answers = await loadAnswers(sessionId);
    expect(answers.housing_status).toEqual({ status: "unknown", value: null });
  });

  it("feeds the fail-open chain: a known pii shelter answer skips housing costs", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "housing_status", "known", "shelter");
    const answers = await loadAnswers(sessionId);
    expect(answers.housing_status).toEqual({ status: "known", value: "shelter" });
  });

  it("returns an empty map for a session with no answers", async () => {
    const { sessionId } = await ensureSession(null);
    expect(await loadAnswers(sessionId)).toEqual({});
  });
});

describe("saveAnswer validation", () => {
  let sessionId: string;

  beforeAll(async () => {
    const session = await ensureSession(null);
    sessionId = session.sessionId;
  });

  async function expectValidationError(promise: Promise<unknown>): Promise<void> {
    const rejection = await rejectionOf(promise);
    expect(rejection).toBeInstanceOf(AppError);
    expect((rejection as AppError).code).toBe("validation_error");
  }

  it("rejects unknown question ids", async () => {
    await expectValidationError(
      saveAnswer(sessionId, "not_a_question", "known", "x"),
    );
  });

  it("rejects inherited Object keys as question ids without dereferencing them", async () => {
    // QUESTION_BY_ID is a plain object: an unguarded index lookup resolves
    // 'constructor' & friends from Object.prototype (truthy!) instead of
    // failing validation — a 500 or a junk row instead of the contracted 400.
    const rowsBefore = await answerRows(sessionId);
    for (const questionId of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
      "isPrototypeOf",
    ]) {
      await expectValidationError(
        saveAnswer(sessionId, questionId, "known", "self"),
      );
      await expectValidationError(
        saveAnswer(sessionId, questionId, "unknown", null),
      );
    }
    expect(await answerRows(sessionId)).toHaveLength(rowsBefore.length);
  });

  it("rejects statuses outside the tri-state", async () => {
    await expectValidationError(
      saveAnswer(sessionId, "application_role", "maybe" as never, "self"),
    );
  });

  it("requires a value for known and unverified answers", async () => {
    await expectValidationError(
      saveAnswer(sessionId, "application_role", "known", undefined),
    );
    await expectValidationError(
      saveAnswer(sessionId, "application_role", "known", ""),
    );
    await expectValidationError(
      saveAnswer(sessionId, "application_role", "unverified", "   "),
    );
  });

  it("rejects select answers outside the spec options", async () => {
    await expectValidationError(
      saveAnswer(sessionId, "application_role", "known", "martian"),
    );
    await expectValidationError(
      saveAnswer(sessionId, "income_sources", "known", ["job", "martian"]),
    );
    await expectValidationError(
      saveAnswer(sessionId, "income_sources", "known", []),
    );
  });

  it("rejects mistyped values", async () => {
    await expectValidationError(
      saveAnswer(sessionId, "household_size", "known", "four"),
    );
    await expectValidationError(
      saveAnswer(sessionId, "household_size", "known", Number.NaN),
    );
    await expectValidationError(
      saveAnswer(sessionId, "veteran_status", "known", "yes"),
    );
    await expectValidationError(
      saveAnswer(sessionId, "date_of_birth", "known", "01/31/1990"),
    );
    await expectValidationError(
      saveAnswer(sessionId, "goal_detail", "known", 42),
    );
  });

  it("accepts lenient numeric strings and stores a number", async () => {
    await saveAnswer(sessionId, "household_size", "known", "3");
    const answers = await loadAnswers(sessionId);
    expect(answers.household_size).toEqual({ status: "known", value: 3 });
  });

  it("ignores any value sent with an unknown status", async () => {
    await saveAnswer(sessionId, "application_role", "unknown", "junk");
    const answers = await loadAnswers(sessionId);
    expect(answers.application_role).toEqual({ status: "unknown", value: null });
  });
});

describe("answers map feeds the flow engine", () => {
  it("a stored unknown answer keeps dependent questions visible", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "housing_status", "unknown", null);
    const answers: AnswerMap = await loadAnswers(sessionId);
    expect(answers.housing_status?.status).toBe("unknown");
    // The fail-open consequence is asserted by the flow engine suite; here we
    // prove the persisted shape it consumes (status unknown, value null).
    expect(answers.housing_status?.value).toBeNull();
  });
});

describe("caseworker assist records (BN-10)", () => {
  it("records an audit note and flips the assist flag", async () => {
    const { sessionId } = await ensureSession(null);
    await recordCaseworkerAssist(sessionId, "Reviewed housing questions together");
    const state = await loadSessionState(sessionId);
    expect(state).not.toBeNull();
    expect(state?.caseworkerAssisted).toBe(true);
    expect(state?.auditNotes).toHaveLength(1);
    expect(state?.auditNotes[0].actorRole).toBe("caseworker");
    expect(state?.auditNotes[0].note).toBe("Reviewed housing questions together");
  });

  it("orders multiple notes oldest first", async () => {
    const { sessionId } = await ensureSession(null);
    await recordCaseworkerAssist(sessionId, "First sitting");
    await recordCaseworkerAssist(sessionId, "Second sitting");
    const state = await loadSessionState(sessionId);
    expect(state?.auditNotes.map((note) => note.note)).toEqual([
      "First sitting",
      "Second sitting",
    ]);
  });

  it("rejects blank or overlong notes", async () => {
    const { sessionId } = await ensureSession(null);
    await expect(recordCaseworkerAssist(sessionId, "   ")).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(
      recordCaseworkerAssist(sessionId, "x".repeat(2001)),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("properties (fast-check)", () => {
  it("stores exactly the trimmed note and flips the assist flag", async () => {
    // The only transformation an assist note undergoes is trimming: for any
    // note with content, the stored note is input.trim() and the session
    // ends up flagged caseworker-assisted.
    const attempts = fc.asyncProperty(
      fc
        .string({ minLength: 1, maxLength: 200 })
        .filter((note) => note.trim().length > 0),
      async (note) => {
        const { sessionId } = await ensureSession(null);
        await recordCaseworkerAssist(sessionId, note);
        const state = await loadSessionState(sessionId);
        return (
          state !== null &&
          state.caseworkerAssisted &&
          state.auditNotes.length === 1 &&
          state.auditNotes[0].note === note.trim()
        );
      },
    );
    await fc.assert(attempts, { numRuns: 50 });
  });

  it("rejects every question id that is not an own spec id, storing nothing", async () => {
    // Totality property: arbitrary junk ids — including every inherited
    // Object.prototype key — get the contracted validation_error, and no
    // answer row is ever written for them.
    const attempts = fc.asyncProperty(
      fc
        .string({ minLength: 1, maxLength: 60 })
        .filter((id) => !Object.hasOwn(QUESTION_BY_ID, id)),
      fc.constantFrom("known", "unknown", "unverified"),
      async (questionId, status) => {
        const { sessionId } = await ensureSession(null);
        const rowsBefore = await answerRows(sessionId);
        let rejected = false;
        try {
          await saveAnswer(sessionId, questionId, status, "self");
        } catch (caught) {
          rejected =
            caught instanceof AppError && caught.code === "validation_error";
        }
        if (!rejected) {
          return false;
        }
        const rowsAfter = await answerRows(sessionId);
        return rowsAfter.length === rowsBefore.length;
      },
    );
    await fc.assert(attempts, { numRuns: 150 });
  });

  it("disavowing any pii answer leaves no vault value behind", async () => {
    // Delete-on-disavow property: for EVERY pii:true question in the spec
    // and any spec-valid value, answering known/unverified then "I'm not
    // sure" empties the session's vault and leaves a value-less unknown
    // answer row.
    const piiMove = fc
      .constantFrom(...PII_QUESTION_IDS_IN_SPEC)
      .chain((field) => {
        const question = QUESTION_BY_ID[field];
        return fc.record({
          field: fc.constant(field),
          status: fc.constantFrom("known", "unverified"),
          value: piiValueArbitrary(question),
        });
      });
    const attempts = fc.asyncProperty(piiMove, async (move) => {
      const { sessionId } = await ensureSession(null);
      await saveAnswer(sessionId, move.field, move.status, move.value);
      expect(await vaultRows(sessionId), `before disavow: ${move.field}`).toHaveLength(1);
      await saveAnswer(sessionId, move.field, "unknown", null);
      expect(await vaultRows(sessionId), `after disavow: ${move.field}`).toHaveLength(0);
      const rows = await answerRows(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("unknown");
      expect(rows[0].value).toBeNull();
    });
    await fc.assert(attempts, { numRuns: 40 });
  });
});

/** A spec-valid value for a question, by type (used for pii questions). */
function piiValueArbitrary(question: Question): fc.Arbitrary<unknown> {
  const optionValues = question.options?.map((option) => option.value);
  switch (question.type) {
    case "single_select":
      return fc.constantFrom(...(optionValues ?? ["x"]));
    case "multi_select":
      return fc.constant(["x"]);
    case "boolean":
      return fc.boolean();
    case "date":
      return fc.constant("1990-01-31");
    case "number":
      return fc.integer({ min: 0, max: 9000 });
    case "text":
    case "address":
      return fc
        .string({ minLength: 1, maxLength: 40 })
        .filter((value) => value.trim().length > 0)
        .map((value) => value.trim());
  }
}
