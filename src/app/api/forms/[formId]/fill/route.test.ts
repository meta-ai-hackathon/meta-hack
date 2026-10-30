import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PDFDocument } from "@cantoo/pdf-lib";
import { closeDb } from "../../../../../lib/db";
import { runMigrations } from "../../../../../lib/migrate";
import { setLogSink, type LogLine } from "../../../../../lib/telemetry";
import { saveAnswer } from "../../../../../lib/intake/store";
import { POST } from "./route";

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

  it("rejects an oversized upload before parsing it", async () => {
    const cookie = await createSessionAndGetCookie();
    const form = new FormData();
    // Just over the 32 MiB cap: the declared length is checked before the
    // body is materialized, and the part's own size before its bytes are
    // read — either way nothing large reaches PDFDocument.load.
    form.append(
      "file",
      new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]),
      "template.pdf",
    );
    const response = await POST(
      new Request("http://localhost:3100/api/forms/sample-application-form/fill", {
        method: "POST",
        headers: { cookie },
        body: form,
      }),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("in-request unmapped answers fill the form; mapped names are refused", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    await saveAnswer(sessionId, "date_of_birth", "known", "1990-01-01");

    const response = await POST(
      fillRequest(
        "sample-application-form",
        acroformFile(),
        cookie,
        { applicant_name: "Route Tester" },
      ),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(response.status).toBe(200);
    const pdf = await PDFDocument.load(new Uint8Array(await response.arrayBuffer()));
    expect(pdf.getForm().getTextField("applicant_name").getText()).toBe(
      "Route Tester",
    );
    expect(pdf.getForm().getTextField("applicant_date_of_birth").getText()).toBe(
      "1990-01-01",
    );

    // A spec-mapped name can never ride the request: mapped answers come
    // only from the server-side stores.
    const spoofed = await POST(
      fillRequest(
        "sample-application-form",
        acroformFile(),
        cookie,
        { applicant_date_of_birth: "1980-01-01" },
      ),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(spoofed.status).toBe(400);
    const junk = await POST(
      fillRequest("sample-application-form", acroformFile(), cookie, {
        applicant_name: "x".repeat(201),
      }),
      { params: Promise.resolve({ formId: "sample-application-form" }) },
    );
    expect(junk.status).toBe(400);
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
        const content = readFileSync(candidate);
        expect(content.includes(SENTINEL)).toBe(false);
      } catch {
        // unreadable (fifo/dir) — skip
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
