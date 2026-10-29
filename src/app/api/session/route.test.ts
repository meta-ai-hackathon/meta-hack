import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import fc from "fast-check";
import { closeDb } from "../../../lib/db";
import { runMigrations } from "../../../lib/migrate";
import { saveAnswer } from "../../../lib/intake/store";
import { SESSION_COOKIE } from "../../../lib/intake/store";
import { POST as answerPost } from "../intake/answer/route";
import { GET, POST } from "./route";
import { QUESTIONS, type Question } from "../../../lib/intake/spec";

// /api/session route tests (BN-13 / HACK-40): create + resume. Runs against
// the real Docker Postgres on its own scratch database, dropped and
// re-created every run. The routes are called as plain functions with the
// platform Request — the same surface a real client hits over HTTP.
//
// Contracts under test:
// - POST creates a session (and sets the httpOnly cookie) for a fresh
//   visitor; with a valid cookie it RESUMES that session and creates no
//   new rows.
// - A caseworker-assisted creation requires and records an audit note
//   (VAL-DM-003), and the notes survive resume intact.
// - GET resumes with the token: identical answers, tri-state statuses, and
//   flow position; nothing to resume is a 404, never a session creation.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_session_route";

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
  // The routes resolve their connection lazily through getDb(); point the
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

function postRequest(body: unknown, cookie?: string): Request {
  return new Request("http://localhost:3100/api/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(cookie?: string): Request {
  return new Request("http://localhost:3100/api/session", {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
}

/** The bn_session=<id> cookie line from a response's set-cookie header. */
function sessionCookieOf(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const found = setCookie
    .split(/,(?=[^;]+=)/)
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!found) {
    throw new Error(`no ${SESSION_COOKIE} cookie in set-cookie: ${setCookie}`);
  }
  return found.split(";")[0];
}

async function countsOf(table: "person" | "session"): Promise<number> {
  const rows = await testDb`SELECT count(*) AS n FROM ${testDb(table)}`;
  return Number(rows[0].n);
}

interface SessionBody {
  session: {
    status: string;
    caseworkerAssisted: boolean;
    createdAt: string;
    updatedAt: string;
    auditNotes: { actorRole: string; note: string; createdAt: string }[];
  };
  state: {
    questions: { id: string }[];
    progress: { answered: number; remaining: number; total: number };
    currentIndex: number | null;
    answers: Record<string, { status: string; value?: unknown }>;
  };
}

describe("POST /api/session (create)", () => {
  it("creates a session for a fresh visitor and sets the httpOnly cookie", async () => {
    const peopleBefore = await countsOf("person");
    const response = await POST(postRequest({}));
    expect(response.status).toBe(201);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure"); // http request: no Secure flag

    const body = (await response.json()) as SessionBody;
    expect(body.session.status).toBe("draft");
    expect(body.session.caseworkerAssisted).toBe(false);
    expect(body.session.auditNotes).toEqual([]);
    expect(new Date(body.session.createdAt).toISOString()).toBe(
      body.session.createdAt,
    );
    expect(body.state.progress).toEqual({
      answered: 0,
      remaining: body.state.progress.total,
      total: body.state.questions.length,
    });
    expect(body.state.currentIndex).toBe(0);
    expect(await countsOf("person")).toBe(peopleBefore + 1);
  });

  it("accepts an empty body (no JSON at all)", async () => {
    const response = await POST(
      new Request("http://localhost:3100/api/session", { method: "POST" }),
    );
    expect(response.status).toBe(201);
  });

  it("marks the session cookie Secure when the request arrived over https", async () => {
    const direct = await POST(
      new Request("https://localhost:3100/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(direct.status).toBe(201);
    expect(direct.headers.get("set-cookie") ?? "").toContain("Secure");

    const proxied = await POST(
      new Request("http://localhost:3100/api/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
        },
        body: "{}",
      }),
    );
    expect(proxied.status).toBe(201);
    expect(proxied.headers.get("set-cookie") ?? "").toContain("Secure");

    // Plain http (localhost dev) keeps the flag off on purpose.
    const plain = await POST(
      new Request("http://localhost:3100/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(plain.status).toBe(201);
    expect(plain.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  it("rejects a caseworker-assisted creation without a note", async () => {
    const sessionsBefore = await countsOf("session");
    for (const body of [{ caseworkerAssisted: true }, { caseworkerAssisted: true, note: "   " }]) {
      const response = await POST(postRequest(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      const payload = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code).toBe("validation_error");
    }
    // The rejected request must not leave an orphan person/session behind.
    expect(await countsOf("session")).toBe(sessionsBefore);
  });

  it("records an audit note when created as caseworker-assisted", async () => {
    const response = await POST(
      postRequest({ caseworkerAssisted: true, note: "Walked through intake together" }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as SessionBody;
    expect(body.session.caseworkerAssisted).toBe(true);
    expect(body.session.auditNotes).toHaveLength(1);
    expect(body.session.auditNotes[0].actorRole).toBe("caseworker");
    expect(body.session.auditNotes[0].note).toBe(
      "Walked through intake together",
    );
    const rows = await testDb`
      SELECT caseworker_assisted FROM session WHERE status = 'draft'
    `;
    expect(rows.some((row) => row.caseworker_assisted === true)).toBe(true);
  });
});

describe("POST /api/session (resume)", () => {
  it("resumes the cookie's session without creating any row", async () => {
    const created = await POST(postRequest({}));
    const cookie = sessionCookieOf(created);
    await saveAnswer(
      cookie.split("=")[1],
      "application_role",
      "known",
      "self",
    );

    const sessionsBefore = await countsOf("session");
    const peopleBefore = await countsOf("person");
    const response = await POST(postRequest({}, cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await countsOf("session")).toBe(sessionsBefore);
    expect(await countsOf("person")).toBe(peopleBefore);

    const body = (await response.json()) as SessionBody;
    expect(body.state.answers.application_role).toEqual({
      status: "known",
      value: "self",
    });
  });

  it("appends an audit note when a caseworker assists on resume", async () => {
    const created = await POST(
      postRequest({ caseworkerAssisted: true, note: "First sitting" }),
    );
    const cookie = sessionCookieOf(created);
    const resumed = await POST(
      postRequest({ caseworkerAssisted: true, note: "Returned with help" }, cookie),
    );
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as SessionBody;
    expect(body.session.caseworkerAssisted).toBe(true);
    expect(body.session.auditNotes.map((note) => note.note)).toEqual([
      "First sitting",
      "Returned with help",
    ]);
  });
});

describe("GET /api/session (resume with the token)", () => {
  it("returns 404 not_found when there is nothing to resume", async () => {
    for (const cookie of [undefined, "other=x", `${SESSION_COOKIE}=not-a-uuid`, `${SESSION_COOKIE}=${crypto.randomUUID()}`]) {
      const response = await GET(getRequest(cookie));
      expect(response.status, cookie ?? "no cookie").toBe(404);
      const payload = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code).toBe("not_found");
    }
  });

  it("restores identical progress through the answer route's cookie", async () => {
    const created = await POST(postRequest({}));
    const cookie = sessionCookieOf(created);

    // Answer two questions over the same HTTP surface the browser uses.
    const answerRequest = (questionId: string, status: string, value: unknown) =>
      new Request("http://localhost:3100/api/intake/answer", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ questionId, status, value }),
      });
    const first = await answerPost(answerRequest("application_role", "known", "self"));
    expect(first.status).toBe(200);
    const second = await answerPost(answerRequest("main_goal", "unknown", null));
    expect(second.status).toBe(200);
    const answeredState = (await second.json()) as SessionBody["state"];

    // Leave and return: the token (cookie) restores the identical state.
    const resumed = await GET(getRequest(cookie));
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as SessionBody;
    expect(body.state).toEqual(answeredState);
    expect(body.state.answers.application_role).toEqual({
      status: "known",
      value: "self",
    });
    expect(body.state.answers.main_goal).toEqual({
      status: "unknown",
      value: null,
    });
    expect(body.state.currentIndex).toBe(answeredState.currentIndex);
    expect(body.session.status).toBe("draft");
  });

  it("keeps caseworker audit notes intact through resume", async () => {
    const created = await POST(
      postRequest({ caseworkerAssisted: true, note: "Assisted intake, first sitting" }),
    );
    const cookie = sessionCookieOf(created);
    await saveAnswer(
      cookie.split("=")[1],
      "household_size",
      "known",
      3,
    );

    const resumed = await GET(getRequest(cookie));
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as SessionBody;
    expect(body.session.caseworkerAssisted).toBe(true);
    expect(body.session.auditNotes).toHaveLength(1);
    expect(body.session.auditNotes[0].note).toBe(
      "Assisted intake, first sitting",
    );
    expect(body.state.answers.household_size).toEqual({
      status: "known",
      value: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Properties (fast-check)
// ---------------------------------------------------------------------------

/** A valid answer value for a question, derived from the spec itself. */
function valueArbitrary(question: Question): fc.Arbitrary<unknown> | undefined {
  const optionValues = question.options?.map((option) => option.value);
  switch (question.type) {
    case "single_select":
      return optionValues
        ? fc.constantFrom(...optionValues)
        : undefined;
    case "multi_select":
      return optionValues
        ? fc
            .array(fc.constantFrom(...optionValues), {
              minLength: 1,
              maxLength: 3,
            })
            .map((items) => [...new Set(items)])
        : undefined;
    case "number":
      return fc.integer({ min: 0, max: 9000 });
    case "boolean":
      return fc.boolean();
    case "date":
      return fc
        .integer({ min: 0, max: 20000 })
        .map((days) => new Date(Date.UTC(2020, 0, 1) + days * 86_400_000).toISOString().slice(0, 10));
    case "text":
    case "address":
      return fc
        .string({ minLength: 1, maxLength: 40 })
        .filter((value) => value.trim().length > 0)
        .map((value) => value.trim());
  }
}

// Non-pii questions the property may answer, with a generable value shape.
const ANSWERABLE_IDS = QUESTIONS.filter(
  (question) => !question.pii && valueArbitrary(question) !== undefined,
).map((question) => question.id);

describe("properties (fast-check)", () => {
  it("resume restores the exact state the last answer POST returned", async () => {
    // BN-13's core property: after ANY sequence of valid tri-state answers,
    // GET /api/session with the token returns the same client state the
    // answer POSTs produced — same answers, statuses, progress, and flow
    // position. State is recomputed from Postgres on every request; nothing
    // rides in memory between calls.
    const answerMove = fc
      .constantFrom(...ANSWERABLE_IDS)
      .chain((questionId) => {
        const question = QUESTIONS.find(
          (candidate) => candidate.id === questionId,
        ) as Question;
        return fc.record({
          questionId: fc.constant(questionId),
          status: fc.constantFrom("known", "unknown", "unverified"),
          value: valueArbitrary(question) as fc.Arbitrary<unknown>,
        });
      });

    const attempts = fc.asyncProperty(
      fc.array(answerMove, { minLength: 1, maxLength: 4 }),
      async (moves) => {
        const created = await POST(postRequest({}));
        expect(created.status).toBe(201);
        const cookie = sessionCookieOf(created);

        let lastState: SessionBody["state"] | null = null;
        for (const move of moves) {
          const response = await answerPost(
            new Request("http://localhost:3100/api/intake/answer", {
              method: "POST",
              headers: { "content-type": "application/json", cookie },
              body: JSON.stringify({
                questionId: move.questionId,
                status: move.status,
                value: move.status === "unknown" ? null : move.value,
              }),
            }),
          );
          expect(response.ok, `answer POST for ${move.questionId}`).toBe(true);
          lastState = (await response.json()) as SessionBody["state"];
        }

        const resumed = await GET(getRequest(cookie));
        expect(resumed.status).toBe(200);
        const body = (await resumed.json()) as SessionBody;
        expect(body.state).toEqual(lastState);
      },
    );
    await fc.assert(attempts, { numRuns: 20 });
  });
});
