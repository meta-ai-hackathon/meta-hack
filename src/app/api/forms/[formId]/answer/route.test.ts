import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../../lib/db";
import { runMigrations } from "../../../../../lib/migrate";
import { setLogSink } from "../../../../../lib/telemetry";
import { loadFormAnswers } from "../../../../../lib/forms/answers";
import { getFormRegistryEntry } from "../../../../../lib/forms/registry";
import { POST } from "./route";

// POST /api/forms/<formId>/answer route tests (Mission v2 M4): form-driven
// answers persist per registry entry; re-answering updates; junk field
// names and values are taxonomy 400s; a fresh visitor's first answer
// creates their session and sets the httpOnly cookie.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_forms_answer_route";

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

const ENTRY = getFormRegistryEntry("sample-application-form");

function answerRequest(
  formId: string,
  body: unknown,
  cookie?: string,
): Request {
  return new Request(`http://localhost:3100/api/forms/${formId}/answer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/forms/<formId>/answer", () => {
  it("saves a form answer for a fresh visitor and sets the cookie", async () => {
    const response = await POST(
      answerRequest(ENTRY.id, { fieldName: "case_number", value: "A-1234" }),
      { params: Promise.resolve({ formId: ENTRY.id }) },
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("bn_session=");
    const sessionId = cookie?.split(";")[0].split("=")[1] ?? "";
    const stored = await loadFormAnswers(sessionId, ENTRY.id);
    expect(stored.case_number?.value).toBe("A-1234");
    expect(stored.case_number?.provenance).toBe("user_supplied");
  });

  it("re-answering the same field updates, never duplicates", async () => {
    const response = await POST(
      answerRequest(ENTRY.id, { fieldName: "case_number", value: "B-2" }),
      { params: Promise.resolve({ formId: ENTRY.id }) },
    );
    const cookie = response.headers.get("set-cookie");
    const sessionId = cookie?.split(";")[0].split("=")[1] ?? "";
    await POST(
      answerRequest(
        ENTRY.id,
        { fieldName: "case_number", value: "B-3" },
        cookie ?? undefined,
      ),
      { params: Promise.resolve({ formId: ENTRY.id }) },
    );
    const rows = await testDb`
      SELECT count(*) AS n FROM form_answer
      WHERE session_id = ${sessionId} AND field_name = 'case_number'
    `;
    expect(Number(rows[0].n)).toBe(1);
    const stored = await loadFormAnswers(sessionId, ENTRY.id);
    expect(stored.case_number?.value).toBe("B-3");
  });

  it("rejects a field the registry does not list", async () => {
    const response = await POST(
      answerRequest(ENTRY.id, { fieldName: "made_up_field", value: "x" }),
      { params: Promise.resolve({ formId: ENTRY.id }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects a spec-mapped field — pii spec answers cannot bypass the vault", async () => {
    // applicant_date_of_birth maps to the pii:true spec question
    // date_of_birth. Its answer belongs to the intake stores (vault for
    // pii), never a plaintext row here.
    const response = await POST(
      answerRequest(ENTRY.id, {
        fieldName: "applicant_date_of_birth",
        value: "1990-01-01",
      }),
      { params: Promise.resolve({ formId: ENTRY.id }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects junk bodies", async () => {
    for (const body of [
      { value: "no field name" },
      { fieldName: "case_number" },
      { fieldName: 3, value: "x" },
      "just a string",
    ]) {
      const response = await POST(answerRequest(ENTRY.id, body), {
        params: Promise.resolve({ formId: ENTRY.id }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("an unknown form id is a 404", async () => {
    const response = await POST(
      answerRequest("no-such-form", { fieldName: "x", value: "y" }),
      { params: Promise.resolve({ formId: "no-such-form" }) },
    );
    expect(response.status).toBe(404);
  });
});
