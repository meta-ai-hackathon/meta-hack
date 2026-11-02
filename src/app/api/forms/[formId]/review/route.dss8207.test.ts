import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../../lib/db";
import { runMigrations } from "../../../../../lib/migrate";
import { setLogSink } from "../../../../../lib/telemetry";
import { saveAnswer } from "../../../../../lib/intake/store";
import { PILOT_CONFIG } from "../../../../../lib/pilot";
import { getFormRegistryEntry } from "../../../../../lib/forms/registry";
import { buildDispositionReport } from "../../../../../lib/forms/disposition";
import { GET } from "./route";

// GET /api/forms/dss-8207/review — the FNS application's review surface
// (snap-form milestone part 2, VAL-SNAP-004/006): one session's answers
// prepare BOTH applications, so the dss-8207 review renders the carried-over
// values (field-level read-back) and never re-asks an answered question, and
// its coverage arithmetic is the DSS-8207's OWN (575 fields), never the
// DHB-5200's numbers. Pii values stay structurally off the client.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_forms_review_dss8207";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

const ENTRY = getFormRegistryEntry("dss-8207");

// The person's answers as the journey stored them: the pii trio routes to
// the vault, the rest are plain rows. contact_preference = "call" makes
// phone_contact visible (and email_contact skipped — a one-preference
// contact choice); housing_status = "rent" keeps the shelter-cost screens
// visible.
const FIXTURE_ANSWERS: readonly {
  id: string;
  status: "known";
  value: unknown;
}[] = [
  { id: "state", status: "known", value: "NC" },
  { id: "housing_status", status: "known", value: "rental_or_own" },
  { id: "housing_cost", status: "known", value: 900 },
  { id: "utilities_cost", status: "known", value: 140 },
  { id: "veteran_status", status: "known", value: false },
  { id: "received_benefits_before", status: "known", value: true },
  { id: "contact_preference", status: "known", value: "call" },
  { id: "date_of_birth", status: "known", value: "1988-04-12" },
  { id: "phone_contact", status: "known", value: "704-555-0134" },
];

// The values that must never leave the server (every pii fixture value in
// this session is free-form enough to be a specific needle).
const PII_VALUES = ["1988-04-12", "704-555-0134"];

const SPEC_LINKED_PREFILLED = [
  "Text5", // state
  "AmountWhat are the total monthly shelter costs rent or mortgage that the household pays",
  "AmountWhat is the total monthly utility cost heat electricity LPNatural Gas WaterSewage GarbageTrash TelephoneCell Phone and Utility Excess Public Housing",
  "A veteran", // veteran_status
  "Does anyone get Food and Nutrition Services Food Stamps or SNAP in this or another county or state",
  "Birth DateSelf", // date_of_birth (pii)
  "Message Number", // phone_contact (pii)
];

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

async function seededSession(): Promise<string> {
  const sessionId = await createSession();
  for (const answer of FIXTURE_ANSWERS) {
    await saveAnswer(sessionId, answer.id, answer.status, answer.value);
  }
  return sessionId;
}

function reviewRequest(formId: string, cookie?: string): Request {
  return new Request(`http://localhost:3100/api/forms/${formId}/review`, {
    headers: cookie ? { cookie } : {},
  });
}

async function readReview(cookie: string): Promise<{
  hasSession: boolean;
  form: { id: string; title: string; version: string };
  programName?: string;
  countyName?: string;
  fields: {
    fieldName: string;
    state: string;
    piiLikely: boolean;
    value?: unknown;
    provenance?: string;
    status?: string;
  }[];
  toResolve: { fieldName: string; question: string }[];
  counts: { prefilled: number; asked: number; notApplicable: number };
  coverage?: {
    counts: Record<string, number>;
    fields: {
      fieldName: string;
      pages: number[];
      disposition: string;
      dispositionReason?: string;
    }[];
  };
  portalLinks: { label: string; url: string }[];
}> {
  const response = await GET(reviewRequest(ENTRY.id, cookie), {
    params: Promise.resolve({ formId: ENTRY.id }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Awaited<ReturnType<typeof readReview>>;
}

describe("GET /api/forms/dss-8207/review", () => {
  it("an anonymous request gets an honest empty payload", async () => {
    const response = await GET(reviewRequest(ENTRY.id), {
      params: Promise.resolve({ formId: ENTRY.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hasSession: boolean };
    expect(body.hasSession).toBe(false);
  });

  it("carries the session's answers over — prefilled, never re-asked (VAL-SNAP-004)", async () => {
    const sessionId = await seededSession();
    const body = await readReview(`bn_session=${sessionId}`);

    expect(body.hasSession).toBe(true);
    expect(body.form.id).toBe("dss-8207");

    // Every spec-linked field with a stored answer is prefilled — carry-over
    // proven at field level. None of them is asked again.
    for (const name of SPEC_LINKED_PREFILLED) {
      const field = body.fields.find((row) => row.fieldName === name);
      expect(field, `field ${name} in the payload`).toBeDefined();
      expect(field?.state, `field ${name} carry-over state`).toBe("prefilled");
    }
    // The email field's contact_preference skip is honest too: with
    // contact_preference "call" the email line is not_applicable — never
    // re-asked either (ask-once includes "skipped on purpose").
    const email = body.fields.find(
      (row) => row.fieldName === "Email Address voluntary",
    );
    expect(email?.state).toBe("not_applicable");

    // The counts reflect the same fact: prefilled ≥ the linked set.
    expect(body.counts.prefilled).toBe(SPEC_LINKED_PREFILLED.length);
  });

  it("keeps pii values off the client: status + provenance render, never the value", async () => {
    const sessionId = await seededSession();
    const body = await readReview(`bn_session=${sessionId}`);

    const dob = body.fields.find((row) => row.fieldName === "Birth DateSelf");
    expect(dob?.state).toBe("prefilled");
    expect(dob?.piiLikely).toBe(true);
    expect(dob !== undefined && !("value" in dob)).toBe(true);
    expect(dob?.status).toBe("known");
    expect(dob?.provenance).toBe("user_supplied");

    const phone = body.fields.find((row) => row.fieldName === "Message Number");
    expect(phone?.state).toBe("prefilled");
    expect(phone !== undefined && !("value" in phone)).toBe(true);

    // The whole serialized payload carries none of the private values.
    const serialized = JSON.stringify(body);
    for (const value of PII_VALUES) {
      expect(serialized).not.toContain(value);
    }
  });

  it("shows non-pii carried values with their display form and provenance", async () => {
    const sessionId = await seededSession();
    const body = await readReview(`bn_session=${sessionId}`);

    const shelter = body.fields.find((row) =>
      row.fieldName.startsWith("AmountWhat are the total monthly shelter"),
    );
    expect(shelter?.state).toBe("prefilled");
    expect(shelter?.value).toBe("900");
    expect(shelter?.provenance).toBe("user_supplied");

    // The boolean answers render as checkbox state, not raw jsonb.
    const veteran = body.fields.find((row) => row.fieldName === "A veteran");
    expect(veteran?.state).toBe("prefilled");
    expect(veteran?.value).toBe("unchecked");
    const before = body.fields.find((row) =>
      row.fieldName.startsWith("Does anyone get Food and Nutrition Services"),
    );
    expect(before?.state).toBe("prefilled");
    expect(before?.value).toBe("checked");
  });

  it("reconciles the DSS-8207's OWN coverage arithmetic (VAL-SNAP-006)", async () => {
    const sessionId = await seededSession();
    const body = await readReview(`bn_session=${sessionId}`);

    const coverage = body.coverage!;
    // Exactly the dss-8207 registry's dispositions — every one of the 575
    // named fields in exactly one bucket. The DHB-5200's numbers (355/164/
    // 29/0/23, total 571) would fail these assertions.
    const expected = buildDispositionReport(ENTRY).counts;
    expect(coverage.counts).toEqual({
      mapped: 525,
      not_collected_by_interview: 5,
      optional_unanswered: 32,
      agency_use_only: 2,
      duplicate_structural: 11,
      total: 575,
    });
    expect(coverage.counts).toEqual(expected);
    expect(coverage.fields.length).toBe(575);
    // The buckets add up.
    const sum =
      coverage.counts.mapped +
      coverage.counts.not_collected_by_interview +
      coverage.counts.optional_unanswered +
      coverage.counts.agency_use_only +
      coverage.counts.duplicate_structural;
    expect(sum).toBe(coverage.counts.total);
    expect(coverage.counts.total).toBe(ENTRY.fields.length);
    // Every unmapped row carries its reason (nothing silently blank).
    for (const row of coverage.fields) {
      if (row.disposition !== "mapped") {
        expect(
          row.dispositionReason?.length ?? 0,
          `row ${row.fieldName} lacks a reason`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("still-needed lists the mapped fields without answers, not the dispositioned ones", async () => {
    const sessionId = await seededSession();
    const body = await readReview(`bn_session=${sessionId}`);

    // Most of the 525 mapped fields have no answer in this fixture — the
    // still-needed list is exactly the asked set.
    const asked = body.fields
      .filter((row) => row.state === "asked")
      .map((row) => row.fieldName);
    expect(body.toResolve.length).toBe(asked.length);
    expect(body.toResolve.map((row) => row.fieldName)).toEqual(asked);
    // And the still-needed rows are never a mapped-but-answered field.
    for (const row of body.toResolve) {
      const field = body.fields.find(
        (candidate) => candidate.fieldName === row.fieldName,
      );
      expect(field?.state).toBe("asked");
    }
  });

  it("carries the SNAP application's program identity and official links from the pilot seam", async () => {
    const sessionId = await seededSession();
    const body = await readReview(`bn_session=${sessionId}`);

    const snap = PILOT_CONFIG.additionalApplications.find(
      (application) => application.formRegistryId === "dss-8207",
    );
    expect(snap).toBeDefined();
    expect(body.programName).toBe(snap?.programName);
    expect(body.countyName).toBe(PILOT_CONFIG.countyName);
    expect(body.portalLinks).toEqual(snap?.portalLinks);
  });
});
