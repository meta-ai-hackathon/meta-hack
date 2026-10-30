import fc from "fast-check";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "./db";
import { persistTurn } from "./conversation";
import { runMigrations } from "./migrate";
import { QUESTIONS } from "./intake/spec";
import {
  ensureSession,
  recordCaseworkerAssist,
  saveAnswer,
} from "./intake/store";
import { purgeSessionData } from "./purge";

// Session purge tests (HACK-80 / VAL-DEMOEXP-006): the purge must be REAL —
// every data row for one session (answer, vault_entry, conversation_turn,
// session_audit_note) verifiably gone, while the bare receipt (the person and
// session rows: that a session happened and where it ended) remains, and no
// other session loses a row. Runs against the real Docker Postgres on its own
// scratch database, dropped and re-created every run.
//
// Seeding goes through the store's public API only (saveAnswer routes pii
// values into the vault internally) — the tests never import the vault
// module, so the import-boundary scan stays clean.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_purge";

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
  // The purge resolves its connection lazily through getDb(); point the
  // environment at the scratch database before any call.
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

async function rowsFor(
  table: "answer" | "vault_entry" | "conversation_turn" | "session_audit_note",
  sessionId: string,
): Promise<number> {
  const rows =
    await testDb`SELECT count(*) AS n FROM ${testDb(table)} WHERE session_id = ${sessionId}`;
  return Number(rows[0].n);
}

/** Seed one of each data row on a session and return its id. */
async function seedEverything(): Promise<string> {
  const { sessionId } = await ensureSession(null);
  await saveAnswer(sessionId, "main_goal", "known", "food");
  // A pii question: saveAnswer routes the value into the vault and keeps
  // the answer row's value NULL.
  await saveAnswer(sessionId, "county", "known", "Mecklenburg");
  await persistTurn(sessionId, "user", "seed turn from the person");
  await persistTurn(sessionId, "assistant", "seed turn from the assistant");
  await recordCaseworkerAssist(sessionId, "seed assist note");
  return sessionId;
}

describe("purgeSessionData", () => {
  it("empties every session data table and reports what it removed", async () => {
    const sessionId = await seedEverything();
    for (const table of [
      "answer",
      "vault_entry",
      "conversation_turn",
      "session_audit_note",
    ] as const) {
      expect(await rowsFor(table, sessionId), `seeded ${table}`).toBeGreaterThan(0);
    }

    const counts = await purgeSessionData(sessionId);

    expect(counts).toEqual({
      answers: 2,
      vaultEntries: 1,
      turns: 2,
      auditNotes: 1,
    });
    for (const table of [
      "answer",
      "vault_entry",
      "conversation_turn",
      "session_audit_note",
    ] as const) {
      expect(await rowsFor(table, sessionId), `${table} after purge`).toBe(0);
    }
  });

  it("keeps the bare receipt: the person and session rows survive", async () => {
    const sessionId = await seedEverything();
    await purgeSessionData(sessionId);
    const sessions =
      await testDb`SELECT id, person_id FROM session WHERE id = ${sessionId}`;
    expect(sessions.length).toBe(1);
    const people = await testDb`SELECT id FROM person WHERE id = ${sessions[0].person_id}`;
    expect(people.length).toBe(1);
  });

  it("touches nothing outside the target session", async () => {
    const survivor = await seedEverything();
    const purged = await seedEverything();

    await purgeSessionData(purged);

    for (const table of [
      "answer",
      "vault_entry",
      "conversation_turn",
      "session_audit_note",
    ] as const) {
      expect(
        await rowsFor(table, survivor),
        `${table} on the untouched session`,
      ).toBeGreaterThan(0);
    }
  });

  it("is idempotent: a second purge removes nothing and succeeds", async () => {
    const sessionId = await seedEverything();
    await purgeSessionData(sessionId);
    const again = await purgeSessionData(sessionId);
    expect(again).toEqual({
      answers: 0,
      vaultEntries: 0,
      turns: 0,
      auditNotes: 0,
    });
  });

  it("purges EVERY session-scoped table that exists (structural completeness)", async () => {
    // The confirmation states that everything is gone except the bare
    // receipt. That claim is enforced HERE structurally: the set of
    // tables carrying a session_id, read from the schema itself, must be
    // exactly the set the purge wipes. A future session-scoped table
    // fails this test until the purge covers it — the exact retention
    // statement can never silently rot as the schema grows.
    const sessionTables = (
      await testDb`
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'session_id'
      `
    ).map((row) => String(row.table_name));
    expect(new Set(sessionTables)).toEqual(
      new Set(["answer", "vault_entry", "conversation_turn", "session_audit_note"]),
    );
  });

  it("wipes every row for arbitrary seeded mixes — pii or not, any question set", async () => {
    const questionIds = QUESTIONS.map((question) => question.id);
    // Text pii questions accept a free-form known value through the store:
    // seeding them creates BOTH a vault row and a NULL-value answer row.
    const textPiiIds = QUESTIONS.filter(
      (question) =>
        question.pii && (question.type === "text" || question.type === "address"),
    ).map((question) => question.id);
    expect(textPiiIds.length).toBeGreaterThan(0);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...questionIds), { maxLength: 8 }),
        fc.array(fc.constantFrom(...textPiiIds), { maxLength: 5 }),
        fc.nat(4),
        fc.boolean(),
        async (answerIds, piiFields, turnCount, assisted) => {
          const { sessionId } = await ensureSession(null);
          // Upserts make duplicates collapse: the distinct sets size the
          // expected counts (answer UNIQUE(session_id, question_id),
          // vault_entry UNIQUE(session_id, field)).
          for (const questionId of answerIds) {
            await saveAnswer(sessionId, questionId, "unknown", null);
          }
          for (const field of piiFields) {
            await saveAnswer(sessionId, field, "known", "property seed text");
          }
          for (let index = 0; index < turnCount; index += 1) {
            await persistTurn(
              sessionId,
              index % 2 === 0 ? "user" : "assistant",
              `seed turn ${index}`,
            );
          }
          if (assisted) {
            await recordCaseworkerAssist(sessionId, "property seed note");
          }

          const counts = await purgeSessionData(sessionId);

          // The pii seeds carry answer rows too (value NULL): the wiped
          // answer population is the union of both seed sets.
          expect(counts.answers).toBe(
            new Set([...answerIds, ...piiFields]).size,
          );
          expect(counts.vaultEntries).toBe(new Set(piiFields).size);
          expect(counts.turns).toBe(turnCount);
          expect(counts.auditNotes).toBe(assisted ? 1 : 0);
          for (const table of [
            "answer",
            "vault_entry",
            "conversation_turn",
            "session_audit_note",
          ] as const) {
            expect(await rowsFor(table, sessionId), table).toBe(0);
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
