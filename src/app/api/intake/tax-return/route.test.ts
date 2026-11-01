import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PDFDocument } from "@cantoo/pdf-lib";
import { closeDb } from "../../../../lib/db";
import { runMigrations } from "../../../../lib/migrate";
import { setLogSink } from "../../../../lib/telemetry";
import { GET as getState } from "../state/route";
import { POST } from "./route";

// POST /api/intake/tax-return route tests (milestone income-capture part 2;
// VAL-INC-006/007/008/013). The route parses an uploaded 1040 in memory and
// returns typed findings for the person to review — and nothing else: the
// sentinel suite proves the document (and every extracted value) is never
// persisted, logged, or echoed server-side, and the path makes zero
// outbound calls. Unreadable inputs get an honest fallback message pointing
// at the manual typing path, with nothing saved and nothing fabricated.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_tax_return_route";

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

afterEach(() => {
  setLogSink(() => undefined);
});

// ---------------------------------------------------------------------------
// Fixture building — the same in-memory approach as tax-parse.test.ts: the
// real IRS template bytes are filled in memory and never written to disk.
// ---------------------------------------------------------------------------

const FIXTURE_URL = new URL(
  "../../../../lib/income/fixtures/f1040.pdf",
  import.meta.url,
);

const P1 = "topmostSubform[0].Page1[0].";
const STATUS_FIELDS: Record<string, string> = {
  single: `${P1}Checkbox_ReadOrder[0].c1_8[0]`,
  married_filing_jointly: `${P1}Checkbox_ReadOrder[0].c1_8[1]`,
  married_filing_separately: `${P1}Checkbox_ReadOrder[0].c1_8[2]`,
  head_of_household: `${P1}c1_8[0]`,
  qualifying_surviving_spouse: `${P1}c1_8[1]`,
};

/** Synthetic-only persona values (HACK-58): SSA never issues 000-area SSNs. */
const DEPENDENT_ROWS = [
  ["Alma", "Rivera", "000-00-0001", "daughter"],
  ["Ben", "Rivera", "000-00-0002", "son"],
] as const;

interface FillSpec {
  wages?: string;
  agi?: string;
  status?: string;
  dependents?: readonly (readonly string[])[];
  /** Seeded into a field the parser never reads (dependent first name). */
  sentinel?: string;
}

async function fillFixture(spec: FillSpec): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.load(readFileSync(FIXTURE_URL), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const form = pdf.getForm();
  if (spec.wages !== undefined) {
    form.getTextField(`${P1}f1_47[0]`).setText(spec.wages);
  }
  if (spec.agi !== undefined) {
    form.getTextField(`${P1}f1_75[0]`).setText(spec.agi);
  }
  if (spec.status !== undefined) {
    form.getCheckBox(STATUS_FIELDS[spec.status]).check();
  }
  (spec.dependents ?? []).slice(0, 4).forEach((row, rowIndex) => {
    row.slice(0, 4).forEach((cell, columnIndex) => {
      const name = `${P1}Table_Dependents[0].Row${rowIndex + 1}[0].f1_${
        31 + rowIndex * 4 + columnIndex
      }[0]`;
      form.getTextField(name).setText(cell);
    });
  });
  if (spec.sentinel !== undefined) {
    // A field the parser never reads for a VALUE (the count only notices
    // the row is occupied): the sentinel lives in the document bytes and
    // must never appear in any storage row, log line, or dump.
    form
      .getTextField(`${P1}Table_Dependents[0].Row1[0].f1_31[0]`)
      .setText(spec.sentinel);
  }
  return pdf.save();
}

/** A blank single-page PDF: the image-only (scanned-like) read surface. */
async function scannedLikePdf(): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return pdf.save();
}

/** A readable PDF that is not a 1040. */
async function non1040Pdf(): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawCircle({ x: 100, y: 100, size: 5 }); // no 1040 identity text
  return pdf.save();
}

function garbageBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(1024).map((_, i) => (i * 37) % 256);
}

/** A minimal PDF-shaped wrapper around one flate stream (the bomb fixture). */
function pdfWithFlateStream(deflated: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = Uint8Array.from(
    "%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode /Length " +
      `${deflated.length} >>\nstream\n`,
    (ch) => ch.charCodeAt(0),
  );
  const tail = Uint8Array.from(
    "\nendstream\nendobj\n%%EOF\n",
    (ch) => ch.charCodeAt(0),
  );
  const out = new Uint8Array(head.length + deflated.length + tail.length);
  out.set(head, 0);
  out.set(deflated, head.length);
  out.set(tail, head.length + deflated.length);
  return out;
}

function encryptedPdf(): Uint8Array<ArrayBuffer> {
  const buf = readFileSync(
    new URL("../../../../lib/forms/fixtures/sample-form-encrypted.pdf", import.meta.url),
  );
  // Fresh copy with its own ArrayBuffer (the Buffer's backing store is
  // typed ArrayBufferLike).
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function uploadRequest(cookie: string, file: Uint8Array<ArrayBuffer>): Request {
  const form = new FormData();
  form.append("file", new Blob([file]), "tax-return.pdf");
  return new Request("http://localhost:3100/api/intake/tax-return", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}

async function createSessionAndGetCookie(): Promise<string> {
  const [person] =
    await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`;
  const [session] =
    await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
  return `bn_session=${session.id}`;
}

async function answerRowCount(sessionId: string): Promise<number> {
  const rows =
    await testDb`SELECT count(*) AS n FROM answer WHERE session_id = ${sessionId}`;
  return Number(rows[0].n);
}

describe("POST /api/intake/tax-return", () => {
  it("returns typed findings from a filled 1040 and saves nothing", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    const bytes = await fillFixture({
      wages: "52500",
      agi: "48200",
      status: "married_filing_jointly",
      dependents: DEPENDENT_ROWS,
    });

    const response = await POST(uploadRequest(cookie, bytes));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      readable: true,
      findings: [
        { field: "wages_line_1a", value: 52500, origin: "acroform_field", confidence: 1 },
        { field: "agi_line_11", value: 48200, origin: "acroform_field", confidence: 1 },
        {
          field: "filing_status",
          value: "married_filing_jointly",
          origin: "acroform_field",
          confidence: 1,
        },
        { field: "dependent_count", value: 2, origin: "acroform_field", confidence: 1 },
      ],
      // 48200 / 12 = 4016.67 — the documented rule rounds halves up.
      monthlyDerived: 4017,
      message: null,
    });

    // Nothing saves until the person confirms (VAL-INC-007): zero rows.
    expect(await answerRowCount(sessionId)).toBe(0);
  });

  it("is deterministic: identical uploads return identical bodies", async () => {
    const cookie = await createSessionAndGetCookie();
    const bytes = await fillFixture({
      wages: "52500",
      agi: "48200",
      status: "single",
    });
    const first = await POST(uploadRequest(cookie, bytes));
    const second = await POST(uploadRequest(cookie, bytes));
    expect(await first.text()).toBe(await second.text());
  });

  it("never presents a confident monthly 0 for a negative AGI", async () => {
    const cookie = await createSessionAndGetCookie();
    // IRS parentheses convention marks a negative amount.
    const bytes = await fillFixture({ agi: "(1200)" });
    const response = await POST(uploadRequest(cookie, bytes));
    const body = await response.json();
    expect(body.readable).toBe(true);
    expect(body.monthlyDerived).toBeNull();
  });

  it("returns an honest fallback for unreadable inputs and saves nothing", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    const cases: Record<string, Uint8Array<ArrayBuffer>> = {
      scanned_like: await scannedLikePdf(),
      non_1040: await non1040Pdf(),
      not_a_pdf: garbageBytes(),
      encrypted: encryptedPdf(),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const response = await POST(uploadRequest(cookie, bytes));
      expect(response.status, name).toBe(200);
      const body = await response.json();
      expect(body.readable, name).toBe(false);
      expect(body.findings, name).toEqual([]);
      expect(body.monthlyDerived, name).toBeNull();
      expect(typeof body.message, name).toBe("string");
      // The fallback points at the manual typing path — nothing fabricated.
      expect(body.message, name).toMatch(/type/i);
      expect(await answerRowCount(sessionId), name).toBe(0);
    }
  });

  it("rejects a request without a session", async () => {
    const bytes = await fillFixture({ wages: "52500" });
    const response = await POST(
      uploadRequest("bn_session=00000000-0000-0000-0000-000000000000", bytes),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects non-multipart requests", async () => {
    const cookie = await createSessionAndGetCookie();
    const response = await POST(
      new Request("http://localhost:3100/api/intake/tax-return", {
        method: "POST",
        headers: { cookie },
        body: "not multipart",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
  });

  it("rejects a multipart request without a file part", async () => {
    const cookie = await createSessionAndGetCookie();
    const form = new FormData();
    form.append("something", "not a file");
    const response = await POST(
      new Request("http://localhost:3100/api/intake/tax-return", {
        method: "POST",
        headers: { cookie },
        body: form,
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
  });

  it("rejects a decompression bomb before parsing, by counted bytes", async () => {
    // A small COMPRESSED pdf whose FlateDecode stream inflates far past
    // the bound: the wire cap alone cannot catch it — the pre-parse
    // decompressed bound must, before pdf-lib ever loads the document.
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    const bombData = deflateSync(new Uint8Array(200 * 1024 * 1024).fill(0));
    expect(bombData.length).toBeLessThan(1024 * 1024); // tiny on the wire
    const bomb = pdfWithFlateStream(bombData);

    const response = await POST(uploadRequest(cookie, bomb));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
    expect(await answerRowCount(sessionId)).toBe(0);
  }, 60_000);

  it("caps oversized uploads with a taxonomy error before parsing", async () => {
    const cookie = await createSessionAndGetCookie();
    const sessionId = cookie.split("=")[1];
    // A body stream over the readBodyCapped limit: the cap fires before any
    // multipart parsing or PDF parsing can happen.
    const megabyte = new Uint8Array(1024 * 1024).fill(1);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 33; i += 1) {
          controller.enqueue(megabyte);
          sent += megabyte.byteLength;
        }
        controller.close();
      },
    });
    expect(sent).toBeGreaterThan(32 * 1024 * 1024);
    const response = await POST(
      new Request("http://localhost:3100/api/intake/tax-return", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "multipart/form-data; boundary=cap",
        },
        body: stream,
        // @ts-expect-error duplex is required for stream bodies and missing
        // from the DOM RequestInit type in this TS lib.
        duplex: "half",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_error");
    expect(await answerRowCount(sessionId)).toBe(0);
  });
});

describe("uploaded documents are never persisted, logged, or echoed (VAL-INC-006)", () => {
  it("zero outbound calls; no file, table, or log line carries the sentinel or values", async () => {
    const cookie = await createSessionAndGetCookie();
    const SENTINEL = "PERSIST-SENTINEL-INC6";
    const bytes = await fillFixture({
      wages: "52500",
      agi: "48200",
      status: "single",
      sentinel: SENTINEL,
    });

    // The upload path makes ZERO outbound network calls: any fetch is a
    // violation, so the spy fails loudly rather than silently allowing one.
    const realFetch = globalThis.fetch;
    let outboundCalls = 0;
    globalThis.fetch = (async () => {
      outboundCalls += 1;
      throw new Error("the upload path must make zero outbound calls");
    }) as typeof fetch;

    const logLines: string[] = [];
    setLogSink((line) => {
      logLines.push(line);
    });

    let bodyText: string;
    try {
      const response = await POST(uploadRequest(cookie, bytes));
      expect(response.status).toBe(200);
      bodyText = await response.text();
    } finally {
      globalThis.fetch = realFetch;
      setLogSink(() => undefined);
    }
    expect(outboundCalls).toBe(0);

    // 1. The response is the person's typed findings only: no sentinel, no
    // raw field dump, no document bytes — just the JSON shape.
    const body = JSON.parse(bodyText);
    expect(Object.keys(body).sort()).toEqual(
      ["findings", "message", "monthlyDerived", "readable"],
    );
    expect(bodyText).not.toContain(SENTINEL);

    // 2. Filesystem: no file in the process tmpdir carries the sentinel.
    const tmpFiles = readdirSync(os.tmpdir());
    for (const name of tmpFiles) {
      const full = path.join(os.tmpdir(), name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        // GH runners keep FIFOs in /tmp; a reader-less open would block.
        continue;
      }
      try {
        const content = readFileSync(full);
        expect(content.includes(SENTINEL)).toBe(false);
      } catch {
        // unreadable (permissions) — skip
      }
    }

    // 3. No bytea columns exist in the app schema (the schema has none,
    // and the upload adds no tables): document bytes have no Postgres home.
    const byteaColumns = await testDb`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE data_type = 'bytea' AND table_schema = 'public'
    `;
    expect(byteaColumns).toEqual([]);

    // 4. NO table ever sees the sentinel or the extracted values.
    for (const table of [
      "person",
      "session",
      "session_audit_note",
      "answer",
      "vault_entry",
      "conversation_turn",
      "schema_migrations",
    ]) {
      for (const needle of [SENTINEL, "52500", "48200"]) {
        const rows = await testDb`
          SELECT count(*) AS n FROM ${testDb(table)}
          WHERE to_jsonb(${testDb(table)})::text LIKE ${"%" + needle + "%"}
        `;
        expect(Number(rows[0].n), `${table} ~ ${needle}`).toBe(0);
      }
    }

    // 5. No log line carries the sentinel or any extracted value.
    for (const line of logLines) {
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain("52500");
      expect(serialized).not.toContain("48200");
    }
  });
});

describe("client payloads carry no unconfirmed tax values (VAL-INC-013)", () => {
  it("the intake state payload has no findings before confirmation", async () => {
    const cookie = await createSessionAndGetCookie();
    const bytes = await fillFixture({ wages: "52500", agi: "48200" });
    const uploaded = await POST(uploadRequest(cookie, bytes));
    expect(uploaded.status).toBe(200);

    const state = await getState(
      new Request("http://localhost:3100/api/intake/state", {
        headers: { cookie },
      }),
    );
    expect(state.status).toBe(200);
    const stateText = await state.text();
    // The proposals live only in the upload response the person is
    // reviewing — the app's client-visible state carries nothing.
    expect(stateText).not.toContain("52500");
    expect(stateText).not.toContain("48200");
    expect(stateText).not.toContain("wages_line_1a");
    expect(stateText).not.toContain("agi_line_11");
  });
});
