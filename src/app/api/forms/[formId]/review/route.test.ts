import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../../lib/db";
import { runMigrations } from "../../../../../lib/migrate";
import { setLogSink } from "../../../../../lib/telemetry";
import { saveAnswer } from "../../../../../lib/intake/store";
import { PILOT_CONFIG } from "../../../../../lib/pilot";
import { getFormRegistryEntry } from "../../../../../lib/forms/registry";
import { GET } from "./route";

// GET /api/forms/<formId>/review route tests (Mission v2 M4, BN-21/23/24 +
// VAL-PDF-002): the review surface shows every field's provenance, the
// to-resolve list, the session's BN-25 status, the pilot seam's portal
// links, and the ordered handoff steps. Pii values are structurally absent
// from the payload; anonymous requests get an honest empty payload; unknown
// form ids are 404s.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_forms_review_route";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

const ENTRY = getFormRegistryEntry("sample-application-form");

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

async function createSession(): Promise<string> {
  const [person] =
    await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`;
  const [session] =
    await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
  return String(session.id);
}

function reviewRequest(formId: string, cookie?: string): Request {
  return new Request(`http://localhost:3100/api/forms/${formId}/review`, {
    headers: cookie ? { cookie } : {},
  });
}

describe("GET /api/forms/<formId>/review", () => {
  it("an anonymous request gets an honest empty payload", async () => {
    const response = await GET(reviewRequest(ENTRY.id), {
      params: Promise.resolve({ formId: ENTRY.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hasSession: boolean };
    expect(body.hasSession).toBe(false);
  });

  it("shows provenance per field and omits pii values structurally", async () => {
    const sessionId = await createSession();
    await saveAnswer(sessionId, "household_size", "known", 3);
    await saveAnswer(sessionId, "date_of_birth", "known", "1990-01-01");
    const response = await GET(
      reviewRequest(ENTRY.id, `bn_session=${sessionId}`),
      { params: Promise.resolve({ formId: ENTRY.id }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      hasSession: boolean;
      form: { id: string; version: string; sourceUrl: string; retrievedAt: string };
      fields: {
        fieldName: string;
        state: string;
        piiLikely: boolean;
        value?: unknown;
        provenance?: string;
      }[];
      toResolve: { fieldName: string; question: string }[];
      sessionStatus: string;
      portalLinks: { label: string; url: string }[];
      steps: { title: string }[];
    };
    expect(body.hasSession).toBe(true);
    expect(body.form.id).toBe(ENTRY.id);
    expect(body.form.version).toBe("1.0.0");
    expect(body.form.sourceUrl).toMatch(/^https:\/\//);
    // Provenance labels on every filled field.
    const household = body.fields.find(
      (field) => field.fieldName === "household_size_count",
    );
    expect(household?.state).toBe("prefilled");
    expect(household?.value).toBe("3");
    expect(household?.provenance).toBe("user_supplied");
    // Pii fields (mapped pii or piiLikely) never carry a value.
    const dob = body.fields.find(
      (field) => field.fieldName === "applicant_date_of_birth",
    );
    expect(dob?.state).toBe("prefilled");
    expect(dob !== undefined && !("value" in dob)).toBe(true);
    // Unmapped fields are asked (their answers ride the fill request and
    // are never stored, so nothing can pre-fill them here).
    const name = body.fields.find(
      (field) => field.fieldName === "applicant_name",
    );
    expect(name?.state).toBe("asked");
    // The serialized payload as a whole never carries the private values.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("1990-01-01");
    // To-resolve + lifecycle + companion links + steps.
    expect(body.toResolve.length).toBeGreaterThan(0);
    expect(body.sessionStatus).toBe("draft");
    expect(body.portalLinks).toEqual(PILOT_CONFIG.portalLinks);
    expect(body.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("an unknown form id is a 404", async () => {
    const response = await GET(reviewRequest("no-such-form"), {
      params: Promise.resolve({ formId: "no-such-form" }),
    });
    expect(response.status).toBe(404);
  });
});
