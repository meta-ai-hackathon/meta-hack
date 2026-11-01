import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PDFDocument } from "@cantoo/pdf-lib";
import { closeDb } from "../../../../../lib/db";
import { runMigrations } from "../../../../../lib/migrate";
import { setLogSink, type LogLine } from "../../../../../lib/telemetry";
import { saveAnswer } from "../../../../../lib/intake/store";
import { fillForSession } from "../../../../../lib/forms/fill";
import { discoverAcroFormFields } from "../../../../../lib/forms/parse";
import {
  getFormRegistryEntry,
  loadTemplatePdf,
} from "../../../../../lib/forms/registry";
import fullPersonaJson from "../../../../../lib/forms/fixtures/dhb5200-full-persona.json";
import { POST } from "./route";

// The full-form persona (fixture data, NOT product data): every in-request
// answer the review-and-complete step can send for the real DHB-5200,
// keyed by the form's real field names.
const fullPersona = fullPersonaJson as Record<string, string>;

// POST /api/forms/<formId>/fill route tests (Mission v2 M4,
// VAL-PDF-003/004/005): the happy path returns filled PDF bytes as an
// attachment with expected values re-parsed from the output; XFA and
// encrypted templates are rejected with taxonomy errors; and the sentinel
// proof shows the filled bytes and answer values are never persisted
// server-side (no file, no bytea column, no transcript row, no log line).

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_forms_fill_route";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../..",
  "lib/forms/fixtures",
);
const acroformFile = () => readFileSync(path.join(FIXTURES, "sample-form-acroform.pdf"));
const xfaFile = () => readFileSync(path.join(FIXTURES, "sample-form-xfa.pdf"));
const encryptedFile = () =>
  readFileSync(path.join(FIXTURES, "sample-form-encrypted.pdf"));

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

afterEach(() => {
  setLogSink(() => undefined);
});

function fillRequest(
  formId: string,
  file: Buffer,
  cookie?: string,
  formValues?: Record<string, string>,
): Request {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file)]), "template.pdf");
  if (formValues) {
    form.append("answers", JSON.stringify(formValues));
  }
  return new Request(`http://localhost:3100/api/forms/${formId}/fill`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
  });
}

async function createSessionAndGetCookie(): Promise<string> {
  // The route tests call handlers as plain functions, so sessions are
  // created in the scratch DB and the cookie is built by hand.
  const [person] =
    await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`;
  const [session] =
    await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
  return `bn_session=${session.id}`;
}

describe("POST /api/forms/<formId>/fill", () => {
  it("returns filled PDF bytes as an attachment with expected values", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    await saveAnswer(sessionId, "date_of_birth", "known", "1990-01-01");
    await saveAnswer(sessionId, "housing_status", "known", "shelter");
    await saveAnswer(sessionId, "phone_contact", "known", "555-0100");

    const response = await POST(
      fillRequest("sample-application-form", acroformFile(), cookie),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const bytes = new Uint8Array(await response.arrayBuffer());
    const pdf = await PDFDocument.load(bytes);
    const form = pdf.getForm();
    expect(form.getTextField("applicant_date_of_birth").getText()).toBe(
      "1990-01-01",
    );
    expect(form.getTextField("contact_phone").getText()).toBe("555-0100");
    expect(
      form.getDropdown("housing_situation").getSelected(),
    ).toEqual(["In a shelter"]);
    // Unknowns are visibly blank.
    expect(form.getTextField("applicant_name").getText() ?? "").toBe("");
  });

  it("a request without an uploaded template fills the committed sample", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    await saveAnswer(sessionId, "date_of_birth", "known", "1990-01-01");
    const response = await POST(
      new Request("http://localhost:3100/api/forms/sample-application-form/fill", {
        method: "POST",
        headers: { cookie },
      }),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pdf = await PDFDocument.load(bytes);
    expect(
      pdf.getForm().getTextField("applicant_date_of_birth").getText(),
    ).toBe("1990-01-01");
  });

  it("rejects an XFA template with a 400 taxonomy error (VAL-PDF-004)", async () => {
    const cookie = await createSessionAndGetCookie();
    const response = await POST(
      fillRequest("sample-application-form", xfaFile(), cookie),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an encrypted template with a 400 taxonomy error (VAL-PDF-004)", async () => {
    const cookie = await createSessionAndGetCookie();
    const response = await POST(
      fillRequest("sample-application-form", encryptedFile(), cookie),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an unknown form id with a 404", async () => {
    const cookie = await createSessionAndGetCookie();
    const response = await POST(
      fillRequest("no-such-form", acroformFile(), cookie),
      { params: Promise.resolve({ formId: "no-such-form" }) },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("a request without a session is a validation error, not a fill", async () => {
    const response = await POST(
      fillRequest("sample-application-form", acroformFile()),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });
});

describe("POST /api/forms/dhb-5200/fill — the REAL form (VAL-RFEX-002)", () => {
  // The demo persona's unmapped answers, keyed by the DHB-5200's real
  // AcroForm field names (the review view's draft inputs send exactly
  // these). SSN, mailing address, and next year's income are deliberately
  // left unanswered — they must come out blank with an honest report.
  const DHB_UNMAPPED = {
    "1 First name Middle name Last name  Suffix": "Jordan A. Tester",
    "2 Home address Leave blank if you dont have one":
      "123 Main St, Charlotte, NC 28202",
  };

  it("fills the committed official bytes from the demo persona; unanswered fields stay blank with the honest report", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    // Mapped answers: pii values (dob, phone, county) cross the vault
    // through the entry's allowlist; the wage + state ride the answer
    // table (non-pii). income_sources keeps job_income_amount inside the
    // flow's visibility.
    await saveAnswer(sessionId, "date_of_birth", "known", "1980-02-03");
    await saveAnswer(sessionId, "phone_contact", "known", "555-010-9911");
    await saveAnswer(sessionId, "state", "known", "NC");
    await saveAnswer(sessionId, "county", "known", "Mecklenburg");
    await saveAnswer(sessionId, "income_sources", "known", ["job"]);
    await saveAnswer(sessionId, "job_income_amount", "known", 1200);

    // NO uploaded template: the registry's committed official DHB-5200
    // bytes are the template (the UI download path). The unmapped persona
    // answers ride the request in memory only.
    const multipart = new FormData();
    multipart.append("answers", JSON.stringify(DHB_UNMAPPED));
    const response = await POST(
      new Request("http://localhost:3100/api/forms/dhb-5200/fill", {
        method: "POST",
        headers: { cookie },
        body: multipart,
      }),
      { params: Promise.resolve({ formId: "dhb-5200" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      "dhb-5200.pdf",
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    // The official document, filled.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");

    const pdf = await PDFDocument.load(bytes);
    const form = pdf.getForm();
    // Mapped fields filled from the session's answers — the DOB in the
    // mm/dd/yyyy format the form itself prints (the field is labelled
    // mmddyyyy; the review P2 fix formats the ISO date for the print).
    expect(form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe(
      "02/03/1980",
    );
    expect(form.getTextField("14 Phone Number").getText()).toBe(
      "555-010-9911",
    );
    expect(form.getTextField("undefined_10").getText()).toBe("1200");
    // The newly mapped home-address lines (full-form mapping part 1): the
    // state renders in its option-label display form; the county crosses
    // the vault through the entry's allowlist.
    expect(form.getTextField("5 State").getText()).toBe("North Carolina");
    expect(form.getTextField("7 County").getText()).toBe("Mecklenburg");
    // Unmapped persona answers rode the request and filled their fields.
    expect(
      form.getTextField("1 First name Middle name Last name  Suffix").getText(),
    ).toBe("Jordan A. Tester");
    expect(
      form.getTextField("2 Home address Leave blank if you dont have one").getText(),
    ).toBe("123 Main St, Charlotte, NC 28202");
    // Unanswered fields stay VISIBLY blank — never guessed.
    expect(
      form.getTextField("5 Social Security Number SSN").getText() ?? "",
    ).toBe("");
    expect(
      form
        .getTextField("8 Mailing Address if different from home address")
        .getText() ?? "",
    ).toBe("");
    expect(
      form
        .getTextField(
          "Your total income next year if you think it will be different",
        )
        .getText() ?? "",
    ).toBe("");

    // The honest unmapped-field report: exactly the unanswered mapped
    // fields, each carrying its real question for the review surface's
    // to-resolve list (the route's log mirrors its size). The demo persona
    // answers the Person 1 fields; every pages 9-15 in-request carrier
    // (full-form mapping part 2) is honestly still-needed here.
    const entry = getFormRegistryEntry("dhb-5200");
    const outcome = await fillForSession(
      loadTemplatePdf(entry),
      entry,
      sessionId,
      DHB_UNMAPPED,
    );
    expect(outcome.toResolve.map((item) => item.fieldName)).toEqual(
      expect.arrayContaining([
        "8 Mailing Address if different from home address",
        "5 Social Security Number SSN",
        "Your total income next year if you think it will be different",
        // The person skipped typing in this fixture: the unsigned signature
        // is honestly noted as still-needed (VAL-VJS2-002 empty path).
        "Signature",
      ]),
    );
    const inRequestSent = new Set(Object.keys(DHB_UNMAPPED));
    const specAnswered = new Set([
      "date_of_birth",
      "phone_contact",
      "state",
      "county",
      "job_income_amount",
    ]);
    const expectedUnfilled = entry.fields
      .filter(
        (field) =>
          field.disposition === "mapped" &&
          (field.specQuestionId === null
            ? !inRequestSent.has(field.name)
            : !specAnswered.has(field.specQuestionId)),
      )
      .map((field) => field.name)
      .sort();
    expect(outcome.toResolve.map((item) => item.fieldName).sort()).toEqual(
      expectedUnfilled,
    );
    for (const item of outcome.toResolve) {
      expect(item.reason).toBe("unknown");
      expect(item.question.length).toBeGreaterThan(0);
    }
    expect(outcome.filled.map((filled) => filled.fieldName).sort()).toEqual(
      [
        "1 First name Middle name Last name  Suffix",
        "2 Home address Leave blank if you dont have one",
        "3 Date of Birth mmddyyyy",
        "5 State",
        "7 County",
        "14 Phone Number",
        "undefined_10",
      ].sort(),
    );
  });

  it("full-coverage fixture: every mapped field INCLUDING the typed signature fills (VAL-VJS2-002)", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    // Synthetic full-coverage persona: a KNOWN answer for every mapped
    // spec question (pii values ride the vault through the entry's
    // allowlist; the wage + state ride the answer table).
    await saveAnswer(sessionId, "date_of_birth", "known", "1979-07-08");
    await saveAnswer(sessionId, "phone_contact", "known", "555-014-2277");
    await saveAnswer(sessionId, "state", "known", "NC");
    await saveAnswer(sessionId, "county", "known", "Mecklenburg");
    await saveAnswer(sessionId, "income_sources", "known", ["job"]);
    await saveAnswer(sessionId, "job_income_amount", "known", 1500);
    // The unmapped persona fields — INCLUDING the typed signature — arrive
    // exactly as the real typed-signature step sends them: the multipart
    // `answers` part, keyed by field name. The signature value exists
    // nowhere else: not in the answer table, not in the vault (there is no
    // spec question for it), never prefilled. The full-form persona (the
    // shared fixture) covers EVERY in-request carrier of the real form —
    // pages 1-8's, the pages 9-15 household-member fields (part 2), and
    // the pages 16-21 fields (part 3) — a count that rides the RAISED
    // in-request cap.
    const FULL_PERSONA = fullPersona;
    const multipart = new FormData();
    multipart.append("answers", JSON.stringify(FULL_PERSONA));
    const response = await POST(
      new Request("http://localhost:3100/api/forms/dhb-5200/fill", {
        method: "POST",
        headers: { cookie },
        body: multipart,
      }),
      { params: Promise.resolve({ formId: "dhb-5200" }) },
    );
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pdf = await PDFDocument.load(bytes);
    const form = pdf.getForm();
    // EVERY mapped field fills — including the signature, with the value
    // the person typed. The signature value is deliberately DIFFERENT from
    // the name field's, proving it is never copied or auto-derived from
    // another field or a stored answer.
    expect(
      form.getTextField("1 First name Middle name Last name  Suffix").getText(),
    ).toBe("Alex Rivera Demo");
    expect(
      form.getTextField("2 Home address Leave blank if you dont have one").getText(),
    ).toBe("101 Test Ave, Sample City, NC 28202");
    expect(
      form
        .getTextField("8 Mailing Address if different from home address")
        .getText(),
    ).toBe("PO Box 9, Sample City, NC 28201");
    expect(form.getTextField("14 Phone Number").getText()).toBe("555-014-2277");
    expect(form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe(
      "07/08/1979",
    );
    expect(form.getTextField("5 State").getText()).toBe("North Carolina");
    expect(form.getTextField("7 County").getText()).toBe("Mecklenburg");
    expect(form.getTextField("5 Social Security Number SSN").getText()).toBe(
      "000-00-0000",
    );
    expect(form.getTextField("undefined_10").getText()).toBe("1500");
    expect(
      form
        .getTextField(
          "Your total income next year if you think it will be different",
        )
        .getText(),
    ).toBe("18000");
    expect(form.getTextField("Signature").getText()).toBe("Alex Rivera");

    // The honest mapped-vs-unmapped coverage report, stated from the
    // artifacts themselves (registry + discovery pass), never a
    // full-coverage claim: X of Y AcroForm fields are mapped, and every
    // UNMAPPED field stays VISIBLY blank.
    const entry = getFormRegistryEntry("dhb-5200");
    const template = await PDFDocument.load(loadTemplatePdf(entry));
    const discovered = discoverAcroFormFields(template);
    // "Mapped" is the registry's mapped DISPOSITION now (full-form mapping
    // parts 1-3): 355 fields take person answers — the person's own
    // review-and-complete step at fill time; the other 216 carry an honest
    // disposition and are never filled.
    const mapped = new Set(
      entry.fields
        .filter((field) => field.disposition === "mapped")
        .map((field) => field.name),
    );
    const unmapped = discovered.filter((field) => !mapped.has(field.name));
    expect(mapped.size).toBe(355);
    expect(discovered.length).toBe(614);
    // Never fabricated: every mapped name exists in the template's own
    // discovery pass (multi-widget names — radio pairs — appear once in the
    // mapped set and per-widget in the discovery walk, so the arithmetic
    // the old single-widget mapping allowed doesn't reduce widget counts).
    const discoveredNames = new Set(discovered.map((field) => field.name));
    for (const name of mapped) {
      expect(discoveredNames.has(name), name).toBe(true);
    }
    // Text-kind unmapped fields, sampled deterministically for speed.
    const blankable = unmapped
      .filter((field) => field.kind === "text")
      .map((field) => field.name);
    expect(blankable.length).toBeGreaterThan(0);
    for (const name of blankable.slice(0, 25)) {
      expect(form.getTextField(name).getText() ?? "", name).toBe("");
    }

    // Outcome-level: every mapped field filled, nothing left to resolve.
    const outcome = await fillForSession(
      loadTemplatePdf(entry),
      entry,
      sessionId,
      FULL_PERSONA,
    );
    expect(outcome.filled.length).toBe(mapped.size);
    expect(outcome.toResolve).toEqual([]);
  });

  it("the person skips typing: the form downloads unsigned, signature noted in to-resolve (VAL-VJS2-002)", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    // The session HAS stored answers — yet nothing may pre-fill the
    // signature: its only source is fresh typed input on the fill request,
    // and this request carries none.
    await saveAnswer(sessionId, "date_of_birth", "known", "1979-07-08");
    await saveAnswer(sessionId, "phone_contact", "known", "555-014-2277");
    await saveAnswer(sessionId, "income_sources", "known", ["job"]);
    await saveAnswer(sessionId, "job_income_amount", "known", 1500);
    const multipart = new FormData();
    multipart.append(
      "answers",
      JSON.stringify({
        "1 First name Middle name Last name  Suffix": "Alex Rivera Demo",
        "2 Home address Leave blank if you dont have one":
          "101 Test Ave, Charlotte, NC 28202",
      }),
    );
    const response = await POST(
      new Request("http://localhost:3100/api/forms/dhb-5200/fill", {
        method: "POST",
        headers: { cookie },
        body: multipart,
      }),
      { params: Promise.resolve({ formId: "dhb-5200" }) },
    );
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pdf = await PDFDocument.load(bytes);
    // The signature line stays VISIBLY BLANK — the app never signs.
    expect(pdf.getForm().getTextField("Signature").getText() ?? "").toBe("");

    const entry = getFormRegistryEntry("dhb-5200");
    const outcome = await fillForSession(
      loadTemplatePdf(entry),
      entry,
      sessionId,
      {},
    );
    expect(outcome.toResolve).toContainEqual(
      expect.objectContaining({ fieldName: "Signature" }),
    );
  });
});

describe("filled PDFs are never persisted server-side (VAL-PDF-005)", () => {
  const SENTINEL = "PERSIST-SENTINEL-KQ92";

  it("no file, bytea column, transcript row, or log line ever carries the sentinel", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    // Seed the vault pii value through the sanctioned store, and send the
    // unmapped answer as an IN-REQUEST value: it never touches a store at
    // all, so step 3 asserts it appears in NO table.
    await saveAnswer(sessionId, "date_of_birth", "known", "1990-01-01");

    const logLines: LogLine[] = [];
    setLogSink((line) => logLines.push(JSON.parse(line) as LogLine));

    const response = await POST(
      fillRequest(
        "sample-application-form",
        acroformFile(),
        cookie,
        { applicant_name: SENTINEL },
      ),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The response IS the filled PDF carrying the person's values — the
    // product. What must never happen is a SERVER-SIDE copy.
    expect(bytes.length).toBeGreaterThan(0);
    setLogSink(() => undefined);

    // 1. Filesystem: no file in the process tmpdir carries the sentinel.
    const tmpFiles = readdirSync(os.tmpdir());
    for (const name of tmpFiles) {
      const candidate = path.join(os.tmpdir(), name);
      try {
        // Only REGULAR files are read: open()ing a FIFO for read blocks
        // until a writer appears (a synchronous freeze — this hung the CI
        // runner), and directories/sockets are not candidate stores. Size
        // is bounded so no giant pre-existing file dominates the run.
        const stat = statSync(candidate, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.size > 64 * 1024 * 1024) {
          continue;
        }
        const content = readFileSync(candidate);
        expect(content.includes(SENTINEL)).toBe(false);
      } catch {
        // unreadable (permissions) — skip
      }
    }

    // 2. No bytea columns exist anywhere (the schema has none, and the fill
    // adds no tables): filled bytes have no Postgres home.
    const byteaColumns = await testDb`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE data_type = 'bytea' AND table_schema = 'public'
    `;
    expect(byteaColumns).toEqual([]);

    // 3. NO table ever sees the sentinel — the in-request answer has no
    // server-side home by design.
    for (const table of [
      "answer",
      "vault_entry",
      "conversation_turn",
      "session_audit_note",
      "session",
      "person",
    ]) {
      const rows = await testDb`
        SELECT count(*) AS n FROM ${testDb(table)}
        WHERE to_jsonb(${testDb(table)})::text LIKE ${"%" + SENTINEL + "%"}
      `;
      expect(Number(rows[0].n), table).toBe(0);
    }

    // 4. No log line carries the sentinel or the values.
    for (const line of logLines) {
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain("1990-01-01");
      expect(serialized).not.toContain("555-0100");
      expect(serialized).not.toContain("applicant_name");
    }

    // 5. Static backstop: neither the fill module nor the route imports a
    // filesystem API at all — there is no path to a server-side file.
    for (const modulePath of [
      path.resolve(
        import.meta.dirname,
        "../../../../../lib/forms/fill.ts",
      ),
      path.resolve(import.meta.dirname, "./route.ts"),
    ]) {
      const source = readFileSync(modulePath, "utf8");
      expect(source).not.toMatch(/from\s+["'](node:)?fs/);
      expect(source).not.toMatch(/require\(["'](node:)?fs/);
      expect(source).not.toContain("writeFile");
    }
  });
});
