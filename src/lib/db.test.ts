import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getDb, closeDb } from "./db";
import { runMigrations } from "./migrate";

// Integration suite for the BN-02/HACK-27 data model. Runs against the real
// Docker Postgres (see services.yaml) on a scratch database that is dropped
// and re-created from scratch on every run, so migrations are always tested
// fresh.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

const CORE_TABLES = [
  "answer",
  "person",
  "schema_migrations",
  "session",
  "session_audit_note",
  "vault_entry",
] as const;

const SESSION_STATUSES = [
  "draft",
  "prepared",
  "handed_off",
  "user_reported_submitted",
  "user_reported_decided",
] as const;

const ANSWER_STATUSES = ["known", "unknown", "unverified"] as const;
const ANSWER_PROVENANCES = [
  "user_supplied",
  "ai_drafted",
  "source_verified",
] as const;

let admin: postgres.Sql;
let testDb: postgres.Sql;
let firstRun: string[];

async function expectPostgresError(
  statement: Promise<unknown>,
  sqlstate: string,
): Promise<void> {
  try {
    await statement;
  } catch (error) {
    expect(
      (error as { code?: string }).code,
      `expected SQLSTATE ${sqlstate}`,
    ).toBe(sqlstate);
    return;
  }
  throw new Error(`expected statement to fail with SQLSTATE ${sqlstate}`);
}

async function tableNames(db: postgres.Sql): Promise<string[]> {
  const rows = await db`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;
  return rows.map((row) => String(row.table_name));
}

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  firstRun = await runMigrations(testDb);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([
    admin.end({ timeout: 1 }),
    testDb.end({ timeout: 1 }),
  ]);
  await closeDb();
});

describe("fresh migration application (VAL-DM-001)", () => {
  it("applies migrations to a fresh database", () => {
    expect(firstRun).toEqual(["0001_core.sql", "0002_vault_entry.sql"]);
  });

  it("creates all six tables", async () => {
    expect(await tableNames(testDb)).toEqual(CORE_TABLES);
  });

  it("tracks applied migrations and re-runs nothing", async () => {
    const recorded = await testDb`SELECT filename FROM schema_migrations`;
    expect(recorded.map((row) => String(row.filename))).toEqual([
      "0001_core.sql",
      "0002_vault_entry.sql",
    ]);
    expect(await runMigrations(testDb)).toEqual([]);
  });
});

describe("session status vocabulary (VAL-DM-002)", () => {
  it("accepts exactly the BN-25 lifecycle statuses", async () => {
    const person = (
      await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`
    )[0];
    for (const status of SESSION_STATUSES) {
      const rows =
        await testDb`INSERT INTO session (person_id, status)
          VALUES (${person.id}, ${status}) RETURNING status`;
      expect(rows[0].status).toBe(status);
    }
  });

  it("rejects statuses outside the BN-25 vocabulary", async () => {
    const person = (
      await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`
    )[0];
    // 'submitted' is only ever user-reported; the app can never set it (BN-25).
    for (const status of ["submitted", "in_progress", "complete"]) {
      await expectPostgresError(
        testDb`INSERT INTO session (person_id, status)
          VALUES (${person.id}, ${status})`,
        "23514",
      );
    }
  });
});

describe("answer tri-state and provenance (VAL-DM-004)", () => {
  it("round-trips every status and provenance combination", async () => {
    const person = (
      await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`
    )[0];
    const session = (
      await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`
    )[0];

    for (const status of ANSWER_STATUSES) {
      for (const provenance of ANSWER_PROVENANCES) {
        const expectedValue =
          status === "unknown" ? null : { answer: `${status}/${provenance}` };
        // postgres.js serializes sql.json() values as JSON; a raw string
        // parameter would be double-encoded.
        const valueParam =
          expectedValue === null ? null : testDb.json(expectedValue);
        await testDb`
          INSERT INTO answer (session_id, question_id, value, status, provenance)
          VALUES (${session.id}, 'q_test_roundtrip', ${valueParam}, ${status}, ${provenance})
          ON CONFLICT (session_id, question_id)
          DO UPDATE SET value = EXCLUDED.value, status = EXCLUDED.status,
                        provenance = EXCLUDED.provenance,
                        answered_at = now()
        `;
        const [row] = await testDb`SELECT value, status, provenance
          FROM answer
          WHERE session_id = ${session.id} AND question_id = 'q_test_roundtrip'`;
        expect(row.status).toBe(status);
        expect(row.provenance).toBe(provenance);
        expect(row.value).toEqual(expectedValue);
      }
    }
  });

  it("stores unknown answers without a value", async () => {
    const person = (
      await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`
    )[0];
    const session = (
      await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`
    )[0];
    const rows = await testDb`
      INSERT INTO answer (session_id, question_id, value, status, provenance)
      VALUES (${session.id}, 'q_test_unknown', NULL, 'unknown', 'user_supplied')
      RETURNING value, status`;
    expect(rows[0].status).toBe("unknown");
    expect(rows[0].value).toBeNull();
  });

  it("rejects statuses and provenances outside the closed vocabularies", async () => {
    const person = (
      await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`
    )[0];
    const session = (
      await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`
    )[0];
    for (const status of ["maybe", "sure", "true"]) {
      await expectPostgresError(
        testDb`INSERT INTO answer (session_id, question_id, status, provenance)
          VALUES (${session.id}, 'q_test_bad', ${status}, 'user_supplied')`,
        "23514",
      );
    }
    for (const provenance of ["guessed", "model", "user-supplied"]) {
      await expectPostgresError(
        testDb`INSERT INTO answer (session_id, question_id, status, provenance)
          VALUES (${session.id}, 'q_test_bad', 'known', ${provenance})`,
        "23514",
      );
    }
  });

  it("updates rather than duplicates on re-answer", async () => {
    const person = (
      await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`
    )[0];
    const session = (
      await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`
    )[0];

    await testDb`
      INSERT INTO answer (session_id, question_id, value, status, provenance)
      VALUES (${session.id}, 'q_test_update', '{"answer": "first"}'::jsonb, 'unverified', 'ai_drafted')
      ON CONFLICT (session_id, question_id) DO UPDATE
      SET value = EXCLUDED.value, status = EXCLUDED.status, provenance = EXCLUDED.provenance`;

    await testDb`
      INSERT INTO answer (session_id, question_id, value, status, provenance)
      VALUES (${session.id}, 'q_test_update', '{"answer": "confirmed"}'::jsonb, 'known', 'user_supplied')
      ON CONFLICT (session_id, question_id) DO UPDATE
      SET value = EXCLUDED.value, status = EXCLUDED.status, provenance = EXCLUDED.provenance`;

    const [count] =
      await testDb`SELECT count(*)::int AS n FROM answer WHERE session_id = ${session.id}`;
    expect(Number(count.n)).toBe(1);

    const [row] = await testDb`SELECT value, status, provenance
      FROM answer
      WHERE session_id = ${session.id} AND question_id = 'q_test_update'`;
    expect(row.value).toEqual({ answer: "confirmed" });
    expect(row.status).toBe("known");
    expect(row.provenance).toBe("user_supplied");

    // A second row for the same (session, question) is impossible by constraint.
    await expectPostgresError(
      testDb`INSERT INTO answer (session_id, question_id, status, provenance)
        VALUES (${session.id}, 'q_test_update', 'known', 'user_supplied')`,
      "23505",
    );
  });
});

describe("caseworker-assisted audit notes (VAL-DM-003)", () => {
  it("records and returns an audit note for a caseworker-assisted session", async () => {
    const person = (
      await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`
    )[0];
    const session = (
      await testDb`INSERT INTO session (person_id, caseworker_assisted)
        VALUES (${person.id}, true) RETURNING id, caseworker_assisted`
    )[0];
    expect(session.caseworker_assisted).toBe(true);

    await testDb`
      INSERT INTO session_audit_note (session_id, actor_role, note)
      VALUES (${session.id}, 'caseworker', 'Reviewed housing questions together')`;

    const notes = await testDb`
      SELECT session_id, actor_role, note, created_at
      FROM session_audit_note
      WHERE session_id = ${session.id}`;
    expect(notes).toHaveLength(1);
    expect(notes[0].actor_role).toBe("caseworker");
    expect(notes[0].note).toBe("Reviewed housing questions together");
    expect(notes[0].created_at).toBeInstanceOf(Date);
  });

  it("defaults sessions to self-service", async () => {
    const person = (
      await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`
    )[0];
    const session = (
      await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING caseworker_assisted`
    )[0];
    expect(session.caseworker_assisted).toBe(false);
  });
});

describe("db client", () => {
  it("fails loudly when DATABASE_URL is missing", async () => {
    await closeDb(); // drop any cached client from earlier tests
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => getDb()).toThrow(/DATABASE_URL/);
    } finally {
      if (original === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = original;
      }
    }
  });

  it("connects and answers a trivial query", async () => {
    process.env.DATABASE_URL ??= databaseUrl;
    const db = getDb();
    const result = await db`SELECT 1 AS one`;
    expect(Number(result[0].one)).toBe(1);
  });
});
