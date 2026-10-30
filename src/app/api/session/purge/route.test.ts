import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../lib/db";
import { SESSION_STATUSES } from "../../../../lib/honesty";
import { persistTurn } from "../../../../lib/conversation";
import { runMigrations } from "../../../../lib/migrate";
import {
  SESSION_COOKIE,
  ensureSession,
  loadAnswers,
  reportUserReportedStatus,
  saveAnswer,
  setSessionStatus,
} from "../../../../lib/intake/store";
import { GET } from "../route";
import { POST } from "./route";

/** Local shape of the session resume payload (mirrors /api/session GET). */
interface SessionBody {
  state: {
    progress: { answered: number };
    answers: Record<string, unknown>;
  };
}

// Purge route tests (HACK-80 / VAL-DEMOEXP-006/007). Two triggers, both
// explicit, purge a session; everything else refuses and deletes NOTHING:
// - the manual "delete my answers" control sends { confirmed: true };
// - a session ALREADY carrying user_reported_submitted purges without the
//   flag — that state exists only on the person's explicit report (the app
//   never sets it), so the state IS the confirmation. The data-state-driven
//   path is proven here by seeding the state directly (the fax slice owns
//   any UI that would set it; this feature builds none).
// A refused purge leaves the journey intact and resumable.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_purge_route";

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

function purgeRequest(
  cookie?: string,
  body?: Record<string, unknown>,
): Request {
  return new Request("http://localhost:3100/api/session/purge", {
    method: "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Seed data rows and advance the session to the requested BN-25 status. */
async function seedSessionWith(status: string): Promise<string> {
  const { sessionId } = await ensureSession(null);
  await saveAnswer(sessionId, "main_goal", "known", "food");
  // A pii answer: the value routes into the vault, the answer row's value
  // stays NULL.
  await saveAnswer(sessionId, "county", "known", "Mecklenburg");
  await persistTurn(sessionId, "user", "seed turn");
  if (status !== "draft") {
    await setSessionStatus(sessionId, "prepared");
  }
  if (status === "handed_off" || status.startsWith("user_reported")) {
    await setSessionStatus(sessionId, "handed_off");
  }
  if (status.startsWith("user_reported")) {
    await reportUserReportedStatus(
      sessionId,
      status as "user_reported_submitted" | "user_reported_decided",
    );
  }
  return sessionId;
}

async function dataRowCounts(sessionId: string): Promise<{
  answer: number;
  vault_entry: number;
  conversation_turn: number;
}> {
  const rows = await testDb`
    SELECT
      (SELECT count(*) FROM answer WHERE session_id = ${sessionId}) AS answer,
      (SELECT count(*) FROM vault_entry WHERE session_id = ${sessionId}) AS vault_entry,
      (SELECT count(*) FROM conversation_turn WHERE session_id = ${sessionId}) AS conversation_turn
  `;
  return {
    answer: Number(rows[0].answer),
    vault_entry: Number(rows[0].vault_entry),
    conversation_turn: Number(rows[0].conversation_turn),
  };
}

interface PurgeResponse {
  purged: boolean;
  deleted: {
    answers: number;
    vaultEntries: number;
    turns: number;
    auditNotes: number;
  };
}

describe("POST /api/session/purge", () => {
  it("is 404 for a visitor with no session, deleting nothing", async () => {
    const response = await POST(purgeRequest(undefined, { confirmed: true }));
    expect(response.status).toBe(404);
  });

  it(`purges without the flag ONLY from user_reported_submitted, refusing every other status (statuses: ${SESSION_STATUSES.join(", ")})`, async () => {
    for (const status of SESSION_STATUSES) {
      const sessionId = await seedSessionWith(status);
      const response = await POST(purgeRequest(`${SESSION_COOKIE}=${sessionId}`));
      const counts = await dataRowCounts(sessionId);
      if (status === "user_reported_submitted") {
        expect(response.status, status).toBe(200);
        const payload = (await response.json()) as PurgeResponse;
        expect(payload.purged).toBe(true);
        expect(payload.deleted.answers).toBe(2);
        expect(payload.deleted.vaultEntries).toBe(1);
        expect(payload.deleted.turns).toBe(1);
        expect(counts).toEqual({
          answer: 0,
          vault_entry: 0,
          conversation_turn: 0,
        });
      } else {
        expect(response.status, status).toBe(400);
        expect(counts, `${status}: nothing purged`).toEqual({
          answer: 2,
          vault_entry: 1,
          conversation_turn: 1,
        });
      }
    }
  });

  it(`purges on the manual control's explicit confirmation from every status (statuses: ${SESSION_STATUSES.join(", ")})`, async () => {
    for (const status of SESSION_STATUSES) {
      const sessionId = await seedSessionWith(status);
      const response = await POST(
        purgeRequest(`${SESSION_COOKIE}=${sessionId}`, { confirmed: true }),
      );
      expect(response.status, status).toBe(200);
      const payload = (await response.json()) as PurgeResponse;
      expect(payload.purged, status).toBe(true);
      expect(await dataRowCounts(sessionId)).toEqual({
        answer: 0,
        vault_entry: 0,
        conversation_turn: 0,
      });
      // The bare receipt remains: the session row itself survives.
      const sessions =
        await testDb`SELECT id FROM session WHERE id = ${sessionId}`;
      expect(sessions.length, status).toBe(1);
    }
  });

  it("refuses a junk body and deletes nothing", async () => {
    const sessionId = await seedSessionWith("draft");
    const response = await POST(
      purgeRequest(`${SESSION_COOKIE}=${sessionId}`, { confirmed: "yes" }),
    );
    expect(response.status).toBe(400);
    expect(await dataRowCounts(sessionId)).toEqual({
      answer: 2,
      vault_entry: 1,
      conversation_turn: 1,
    });
  });

  it("leaves a refused purge intact and resumable (VAL-DEMOEXP-007)", async () => {
    const { sessionId } = await ensureSession(null);
    await saveAnswer(sessionId, "main_goal", "known", "food");
    await persistTurn(sessionId, "user", "still here turn");

    const refused = await POST(purgeRequest(`${SESSION_COOKIE}=${sessionId}`));
    expect(refused.status).toBe(400);

    const resumed = await GET(
      new Request("http://localhost:3100/api/session", {
        method: "GET",
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
      }),
    );
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as SessionBody;
    expect(Object.keys(body.state.answers)).toContain("main_goal");
    expect(body.state.progress.answered).toBe(1);
    expect(await loadAnswers(sessionId)).toHaveProperty("main_goal");
  });
});
