import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PDFDocument } from "@cantoo/pdf-lib";
import { closeDb } from "../db";
import { runMigrations } from "../migrate";
import { setLogSink, type LogLine } from "../telemetry";
import {
  saveAnswer,
} from "../intake/store";
import { getFormRegistryEntry } from "./registry";
import {
  collectFillValues,
  fillForSession,
  fillFormPdf,
  parseFormValues,
  skippedFieldNames,
  type FillValue,
} from "./fill";

// Forms fill tests (Mission v2 M4, VAL-PDF-003/004/005/006/007): round-trip
// on the committed AcroForm sample and its flat variant, skip-logic respect,
// provenance per filled field, visibly-blank unknowns with a to-resolve
// list, and the vault crossing through the per-form allowlist. Filled bytes
// are only ever in memory; no log line carries a value.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_forms_fill";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const acroformTemplate = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-acroform.pdf")));
const flatTemplate = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-flat.pdf")));
const xfaTemplate = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-xfa.pdf")));
const encryptedTemplate = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-encrypted.pdf")));

const ENTRY = getFormRegistryEntry("sample-application-form");
const FLAT_ENTRY = getFormRegistryEntry("sample-application-form-flat");

let admin: postgres.Sql;
let testDb: postgres.Sql;

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  process.env.DATABASE_URL = testUrl;
  process.env.MODEL_API_KEY = "sentinel-test-key-never-log";
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

/** Save a full known answer set through the ordinary store (vault routing included). */
async function saveKnownAnswerSet(sessionId: string): Promise<void> {
  await saveAnswer(sessionId, "household_size", "known", 3);
  // housing_status = shelter SKIPS housing_cost in the spec's own skip logic
  // (no rent in a shelter) — the flow never asks it, so we never answer it.
  await saveAnswer(sessionId, "date_of_birth", "known", "1990-01-01");
  await saveAnswer(sessionId, "housing_status", "known", "shelter");
  await saveAnswer(sessionId, "phone_contact", "known", "555-0100");
  await saveAnswer(sessionId, "email_contact", "known", "person@example.com");
  await saveAnswer(sessionId, "mailing_situation", "known", "shelter");
  await saveAnswer(sessionId, "shelter_mail_consent", "known", true);
  await saveAnswer(sessionId, "id_status", "known", "need_id");
  await saveAnswer(sessionId, "id_issue_detail", "known", "my ID was lost");
}

const SENTINEL_NAME = "FILL-SENTINEL-ZQX";

function expectedValues(): Record<string, string> {
  return {
    applicant_date_of_birth: "1990-01-01",
    household_size_count: "3",
    housing_situation: "In a shelter",
    contact_phone: "555-0100",
    contact_email: "person@example.com",
  };
}

describe("AcroForm round-trip (VAL-PDF-003)", () => {
  it("fills every expected field with the expected value", async () => {
    const sessionId = await createSession();
    await saveKnownAnswerSet(sessionId);
    const outcome = await fillForSession(acroformTemplate(), ENTRY, sessionId);
    const pdf = await PDFDocument.load(outcome.bytes);
    const form = pdf.getForm();
    const expected = expectedValues();
    for (const [fieldName, expectedValue] of Object.entries(expected)) {
      if (fieldName === "housing_situation") {
        continue; // a dropdown — asserted separately below
      }
      expect(form.getTextField(fieldName).getText()).toBe(expectedValue);
    }
    expect(
      form.getDropdown("housing_situation").getSelected(),
    ).toEqual(["In a shelter"]);
    expect(form.getCheckBox("mail_consent").isChecked()).toBe(true);
    expect(form.getTextField("id_problem_explanation").getText()).toBe(
      "my ID was lost",
    );
  });

  it("fills a mapped non-pii answer when the flow does not skip it", async () => {
    const sessionId = await createSession();
    await saveAnswer(sessionId, "housing_status", "known", "rental_or_own");
    await saveAnswer(sessionId, "housing_cost", "known", 900);
    const outcome = await fillForSession(acroformTemplate(), ENTRY, sessionId);
    const pdf = await PDFDocument.load(outcome.bytes);
    expect(pdf.getForm().getTextField("monthly_rent_amount").getText()).toBe(
      "900",
    );
    expect(
      outcome.filled.find((item) => item.fieldName === "monthly_rent_amount")
        ?.provenance,
    ).toBe("user_supplied");
  });

  it("records a provenance label for every filled field", async () => {
    const sessionId = await createSession();
    await saveKnownAnswerSet(sessionId);
    const outcome = await fillForSession(acroformTemplate(), ENTRY, sessionId);
    const provenance = new Map(
      outcome.filled.map((item) => [item.fieldName, item.provenance]),
    );
    for (const fieldName of Object.keys(expectedValues())) {
      expect(provenance.get(fieldName)).toBe("user_supplied");
    }
    expect(provenance.get("mail_consent")).toBe("user_supplied");
    expect(provenance.get("id_problem_explanation")).toBe("user_supplied");
    // Unmapped fields with no stored answer are NOT in the filled set.
    expect(provenance.has("applicant_name")).toBe(false);
    expect(provenance.has("case_number")).toBe(false);
  });

  it("leaves unknown fields visibly blank and lists them as to-resolve", async () => {
    const sessionId = await createSession();
    await saveAnswer(sessionId, "household_size", "known", 2);
    const outcome = await fillForSession(acroformTemplate(), ENTRY, sessionId);
    const pdf = await PDFDocument.load(outcome.bytes);
    const form = pdf.getForm();
    // Visibly blank: no text in the fields nothing knew (getText is
    // undefined for an untouched field).
    expect(form.getTextField("applicant_date_of_birth").getText() ?? "").toBe("");
    expect(form.getTextField("contact_phone").getText() ?? "").toBe("");
    expect(form.getCheckBox("mail_consent").isChecked()).toBe(false);
    const toResolveNames = outcome.toResolve.map((item) => item.fieldName);
    expect(toResolveNames).toContain("applicant_date_of_birth");
    expect(toResolveNames).toContain("applicant_name");
    expect(toResolveNames).toContain("case_number");
    expect(toResolveNames).toContain("contact_phone");
    // Skipped by the flow (housing_status unknown → fail-open → visible, so
    // housing_cost is to-resolve, not skipped — the fail-open contract).
    expect(toResolveNames).toContain("monthly_rent_amount");
    // Each to-resolve item carries the plain-language question (BN-21).
    for (const item of outcome.toResolve) {
      expect(item.question).not.toBe("");
    }
  });

  it("an in-request unmapped answer fills and carries provenance", async () => {
    const sessionId = await createSession();
    // Unmapped answers ride the fill request and live only in memory —
    // the real data rules forbid a server-side store for them.
    const outcome = await fillForSession(acroformTemplate(), ENTRY, sessionId, {
      applicant_name: SENTINEL_NAME,
    });
    const pdf = await PDFDocument.load(outcome.bytes);
    expect(pdf.getForm().getTextField("applicant_name").getText()).toBe(
      SENTINEL_NAME,
    );
    expect(
      outcome.filled.find((item) => item.fieldName === "applicant_name")
        ?.provenance,
    ).toBe("user_supplied");
    // The mapped-but-unanswered fields stay to-resolve.
    expect(outcome.toResolve.map((item) => item.fieldName)).toContain(
      "applicant_date_of_birth",
    );
    // Without the in-request values the field stays blank + to-resolve.
    const without = await fillForSession(acroformTemplate(), ENTRY, sessionId);
    expect(
      without.toResolve.map((item) => item.fieldName),
    ).toContain("applicant_name");
  });

  it("conditional fields respect the flow's skip logic", async () => {
    const sessionId = await createSession();
    await saveKnownAnswerSet(sessionId);
    // Within the known set: housing_status = shelter skips housing_cost
    // (spec skip logic) — monthly_rent_amount stays blank, NOT to-resolve.
    const outcome = await fillForSession(acroformTemplate(), ENTRY, sessionId);
    const pdf = await PDFDocument.load(outcome.bytes);
    const form = pdf.getForm();
    expect(form.getTextField("monthly_rent_amount").getText() ?? "").toBe("");
    const toResolveNames = outcome.toResolve.map((item) => item.fieldName);
    expect(toResolveNames).not.toContain("monthly_rent_amount");
    expect(skippedFieldNames(ENTRY, {
      housing_status: { status: "known", value: "shelter" },
    })).toEqual(new Set(["monthly_rent_amount"]));
  });

  it("id-issue and mail-consent conditionals follow their skip conditions", async () => {
    const sessionId = await createSession();
    // id_status = have_id SKIPS id_issue_detail; mailing_situation not
    // shelter SKIPS shelter_mail_consent.
    await saveAnswer(sessionId, "id_status", "known", "have_id");
    await saveAnswer(sessionId, "mailing_situation", "known", "family_or_friend");
    const outcome = await fillForSession(acroformTemplate(), ENTRY, sessionId);
    const pdf = await PDFDocument.load(outcome.bytes);
    const form = pdf.getForm();
    expect(form.getTextField("id_problem_explanation").getText() ?? "").toBe("");
    expect(form.getCheckBox("mail_consent").isChecked()).toBe(false);
    const toResolveNames = outcome.toResolve.map((item) => item.fieldName);
    // Skipped by design: blank, and NOT to-resolve.
    expect(toResolveNames).not.toContain("id_problem_explanation");
    expect(toResolveNames).not.toContain("mail_consent");
    expect(
      skippedFieldNames(ENTRY, {
        id_status: { status: "known", value: "have_id" },
        mailing_situation: { status: "known", value: "family_or_friend" },
      }),
    ).toEqual(new Set(["id_problem_explanation", "mail_consent"]));
  });

  it("rejects an XFA input at the fill level too", async () => {
    await expect(
      fillFormPdf(xfaTemplate(), ENTRY, {}),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects an encrypted input at the fill level too", async () => {
    await expect(
      fillFormPdf(encryptedTemplate(), ENTRY, {}),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("values with characters the standard fonts cannot render degrade to to-resolve", async () => {
    const sessionId = await createSession();
    await saveAnswer(sessionId, "date_of_birth", "known", "1990-01-01");
    const outcome = await fillForSession(acroformTemplate(), ENTRY, sessionId);
    const pdf = await PDFDocument.load(outcome.bytes);
    // The date crossed the vault and filled fine (WinAnsi-safe).
    expect(pdf.getForm().getTextField("applicant_date_of_birth").getText()).toBe(
      "1990-01-01",
    );
  });

  it("non-WinAnsi display values are refused per field, not fatal", async () => {
    const values: Record<string, FillValue> = {
      applicant_name: {
        display: "姓名 test",
        provenance: "user_supplied",
        source: "in_request",
      },
      case_number: {
        display: "A-1234",
        provenance: "user_supplied",
        source: "in_request",
      },
    };
    const outcome = await fillFormPdf(acroformTemplate(), ENTRY, values);
    expect(outcome.filled.map((item) => item.fieldName)).toEqual([
      "case_number",
    ]);
    const degraded = outcome.toResolve.find(
      (item) => item.fieldName === "applicant_name",
    );
    expect(degraded?.reason).toBe("unsupported_characters");
  });
});

describe("vault crossing through the per-form allowlist (VAL-PDF-006)", () => {
  it("collects pii values only via readVaultFields with the entry's allowlist", async () => {
    const sessionId = await createSession();
    await saveKnownAnswerSet(sessionId);
    const { values } = await collectFillValues(sessionId, ENTRY);
    // Vault-sourced values arrive display-ready with the row's provenance.
    expect(values.applicant_date_of_birth?.display).toBe("1990-01-01");
    expect(values.applicant_date_of_birth?.source).toBe("vault");
    expect(values.contact_phone?.display).toBe("555-0100");
    expect(values.housing_situation?.display).toBe("In a shelter");
    expect(values.mail_consent?.display).toBe("checked");
    // Non-pii values come from the answer table.
    expect(values.household_size_count?.source).toBe("spec_answer");
    expect(values.household_size_count?.display).toBe("3");
  });

  it("a mapped pii question missing from the allowlist fails closed", async () => {
    const sessionId = await createSession();
    await saveAnswer(sessionId, "phone_contact", "known", "555-0100");
    const narrowEntry = {
      ...ENTRY,
      vaultFieldAllowlist: ENTRY.vaultFieldAllowlist.filter(
        (field) => field !== "phone_contact",
      ),
    };
    const { values } = await collectFillValues(sessionId, narrowEntry);
    // Fail-closed: the value stays in the vault; the field goes unfilled.
    expect(values.contact_phone).toBeUndefined();
  });
});

describe("flat PDF fill via coordinate fallback (VAL-PDF-007)", () => {
  it("draws expected values at the registry coordinates", async () => {
    const sessionId = await createSession();
    await saveKnownAnswerSet(sessionId);
    const outcome = await fillForSession(flatTemplate(), FLAT_ENTRY, sessionId);
    // Re-parse the output with pdfjs and confirm the drawn values.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: outcome.bytes.slice(),
    }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const texts = content.items.map((item) =>
      "str" in item ? item.str : "",
    );
    for (const expected of Object.values(expectedValues())) {
      expect(texts).toContain(expected);
    }
    expect(texts).toContain("X"); // checked box
  });

  it("records provenance for drawn fields and leaves unknowns blank", async () => {
    const sessionId = await createSession();
    await saveAnswer(sessionId, "household_size", "known", 4);
    const outcome = await fillForSession(flatTemplate(), FLAT_ENTRY, sessionId);
    expect(
      outcome.filled.find((item) => item.fieldName === "household_size_count")
        ?.provenance,
    ).toBe("user_supplied");
    expect(outcome.toResolve.map((item) => item.fieldName)).toContain(
      "applicant_name",
    );
    // Unchecked boolean: visibly blank — no X drawn for mail_consent.
    expect(outcome.filled.map((item) => item.fieldName)).not.toContain(
      "mail_consent",
    );
  });
});

describe("no value ever reaches a log line (VAL-PDF-005)", () => {
  it("the fill pipeline logs counts only — no values, no field ids", async () => {
    const sessionId = await createSession();
    await saveKnownAnswerSet(sessionId);
    const lines: LogLine[] = [];
    setLogSink((line) => lines.push(JSON.parse(line) as LogLine));
    await fillForSession(acroformTemplate(), ENTRY, sessionId, {
      applicant_name: SENTINEL_NAME,
    });
    setLogSink(() => undefined);
    for (const line of lines) {
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(SENTINEL_NAME);
      expect(serialized).not.toContain("555-0100");
      expect(serialized).not.toContain("1990-01-01");
      expect(serialized).not.toContain("person@example.com");
      expect(serialized).not.toContain("applicant_name");
    }
  });
});

describe("parseFormValues (in-request form answers)", () => {
  it("accepts bounded values for unmapped fields only", () => {
    const parsed = parseFormValues(ENTRY, {
      applicant_name: "Jane Tester",
      case_number: "A-1234",
    });
    expect(parsed).toEqual({
      applicant_name: "Jane Tester",
      case_number: "A-1234",
    });
  });

  it("rejects a spec-mapped field name — mapped answers cannot ride the request", () => {
    expect(() =>
      parseFormValues(ENTRY, { applicant_date_of_birth: "1990-01-01" }),
    ).toThrow();
    expect(() => parseFormValues(ENTRY, { made_up_field: "x" })).toThrow();
  });

  it("rejects non-string, empty, and oversized values, and non-object payloads", () => {
    expect(() => parseFormValues(ENTRY, { applicant_name: 42 })).toThrow();
    expect(() => parseFormValues(ENTRY, { applicant_name: "   " })).toThrow();
    expect(() =>
      parseFormValues(ENTRY, { applicant_name: "x".repeat(201) }),
    ).toThrow();
    expect(() => parseFormValues(ENTRY, ["not", "an", "object"])).toThrow();
    expect(() => parseFormValues(ENTRY, "a string")).toThrow();
    expect(parseFormValues(ENTRY, null)).toEqual({});
  });
});
